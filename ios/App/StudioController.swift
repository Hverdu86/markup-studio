import UIKit
import UniformTypeIdentifiers
import WebKit

@MainActor
final class StudioController: NSObject, ObservableObject {
    let webView: WKWebView
    private var loaded = false
    private var waiting: [URL] = []
    private let selfTest = ProcessInfo.processInfo.arguments.contains("-selftest")
    private var selfTestSaved: [String: String] = [:]

    override init() {
        let config = WKWebViewConfiguration()
        config.userContentController.addUserScript(
            WKUserScript(source: StudioController.shim, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.addUserScript(
            WKUserScript(source: StudioController.viewport, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        webView.configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "redline")
        webView.navigationDelegate = self
        let slate = UIColor(red: 15 / 255, green: 23 / 255, blue: 42 / 255, alpha: 1)
        webView.isOpaque = false
        webView.backgroundColor = slate
        webView.scrollView.backgroundColor = slate
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsLinkPreview = false
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        loadStudio()
    }

    private func loadStudio() {
        guard let folder = Bundle.main.url(forResource: "assets", withExtension: nil) else { return }
        webView.loadFileURL(folder.appendingPathComponent("Redline_markup_studio.html"), allowingReadAccessTo: folder)
    }

    // MARK: Files handed over by other apps ("Open in", share to the app)

    func open(_ url: URL) {
        guard loaded else { waiting.append(url); return }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { return }
        let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        Task { _ = await run("return await window.REDLINE_MARKUP_STUDIO_ADD(dataUrl, name)",
                             ["dataUrl": dataURL(data, mime), "name": url.lastPathComponent]) }
    }

    // MARK: Requests from the page

    private func handle(_ action: String, _ body: [String: Any]) async -> [String: Any] {
        switch action {
        case "save", "share":
            var files: [(String, Data)] = []
            if action == "save", let name = body["filename"] as? String, let data = decode(body["data"]) {
                files.append((name, data))
            }
            if action == "share", let list = body["files"] as? [[String: Any]] {
                for item in list {
                    if let name = item["filename"] as? String, let data = decode(item["data"]) { files.append((name, data)) }
                }
            }
            guard !files.isEmpty else { return ["error": "nothing to save"] }
            return await export(files)
        case "copyImage":
            guard let data = decode(body["data"]), let image = UIImage(data: data) else { return ["error": "bad image"] }
            UIPasteboard.general.image = image
            return ["ok": true]
        case "copyText":
            UIPasteboard.general.string = body["text"] as? String ?? ""
            return ["ok": true]
        case "paste":
            return ["items": pasteboardItems()]
        case "fetch":
            return await fetch(body["url"] as? String ?? "")
        default:
            return ["error": "unknown action"]
        }
    }

    /// Writes the files to a temporary folder and hands them to the share sheet:
    /// Save to Files, Save Image, AirDrop, or straight into the Claude app.
    private func export(_ files: [(String, Data)]) async -> [String: Any] {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("export-\(UUID().uuidString)", isDirectory: true)
        var urls: [URL] = []
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            for (name, data) in files {
                let safe = name.components(separatedBy: CharacterSet(charactersIn: "/\\:")).joined(separator: "_")
                let url = folder.appendingPathComponent(safe.isEmpty ? "redline_markup.png" : safe)
                try data.write(to: url)
                urls.append(url)
                if selfTest {
                    selfTestSaved[safe] = "\(data.count) bytes, starts \(String(decoding: data.prefix(5), as: UTF8.self).filter { $0.isASCII && !$0.isNewline })"
                }
            }
        } catch {
            return ["error": "could not write the file"]
        }
        if selfTest { return ["ok": true] }
        guard let presenter = topViewController() else { return ["error": "no window"] }
        return await withCheckedContinuation { (continuation: CheckedContinuation<[String: Any], Never>) in
            let sheet = UIActivityViewController(activityItems: urls, applicationActivities: nil)
            sheet.completionWithItemsHandler = { _, completed, _, _ in
                continuation.resume(returning: completed ? ["ok": true] : ["error": "cancelled"])
            }
            if let popover = sheet.popoverPresentationController {   // iPad shows the sheet as a popover
                popover.sourceView = self.webView
                popover.sourceRect = CGRect(x: self.webView.bounds.midX, y: 44, width: 1, height: 1)
                popover.permittedArrowDirections = [.up]
            }
            presenter.present(sheet, animated: true)
        }
    }

    private func pasteboardItems() -> [[String: String]] {
        let board = UIPasteboard.general
        if let pdf = board.data(forPasteboardType: UTType.pdf.identifier) {
            return [["name": "pasted.pdf", "dataUrl": dataURL(pdf, "application/pdf")]]
        }
        if let image = board.image, let png = upright(image).pngData() {
            return [["name": "pasted-image.png", "dataUrl": dataURL(png, "image/png")]]
        }
        if let url = board.url, isWeb(url) { return [["url": url.absoluteString]] }
        if let text = board.string?.trimmingCharacters(in: .whitespacesAndNewlines), let url = URL(string: text), isWeb(url) {
            return [["url": text]]
        }
        return []
    }

    /// Loads a web image natively, so sites that refuse a web page's request still work.
    private func fetch(_ address: String) async -> [String: Any] {
        guard let url = URL(string: address), isWeb(url) else { return ["error": "bad address"] }
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                return ["error": "the site refused"]
            }
            return ["dataUrl": dataURL(data, response.mimeType ?? "application/octet-stream"),
                    "name": response.suggestedFilename ?? url.lastPathComponent]
        } catch {
            return ["error": "could not load"]
        }
    }

    // MARK: Helpers

    private func isWeb(_ url: URL) -> Bool {
        let scheme = url.scheme?.lowercased()
        return scheme == "http" || scheme == "https"
    }

    private func decode(_ value: Any?) -> Data? {
        guard let text = value as? String else { return nil }
        return Data(base64Encoded: text, options: .ignoreUnknownCharacters)
    }

    private func dataURL(_ data: Data, _ mime: String) -> String {
        "data:\(mime);base64,\(data.base64EncodedString())"
    }

    /// Photos carry their rotation as a flag; redraw so the pixels themselves are the right way up.
    private func upright(_ image: UIImage) -> UIImage {
        guard image.imageOrientation != .up else { return image }
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = image.scale
        return UIGraphicsImageRenderer(size: image.size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: image.size))
        }
    }

    private func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
        var controller = scene?.windows.first(where: { $0.isKeyWindow })?.rootViewController ?? scene?.windows.first?.rootViewController
        while let presented = controller?.presentedViewController { controller = presented }
        return controller
    }

    /// Runs JavaScript in the page and waits for its result.
    private func run(_ body: String, _ arguments: [String: Any] = [:], timeout seconds: Int = 0) async -> Any? {
        // with a timeout, a step that never finishes reports "TIMEOUT" instead of stalling everything after it
        let script = seconds > 0
            ? "return await Promise.race([(async () => { \(body)\n })(), new Promise(done => setTimeout(() => done('TIMEOUT'), \(seconds * 1000)))])"
            : body
        return await withCheckedContinuation { (continuation: CheckedContinuation<Any?, Never>) in
            webView.callAsyncJavaScript(script, arguments: arguments, in: nil, in: .page) { result in
                switch result {
                case .success(let value): continuation.resume(returning: value)
                case .failure(let error): continuation.resume(returning: "JS error: \(error.localizedDescription)")
                }
            }
        }
    }

    // MARK: Self-test (launch argument -selftest; used by the automated simulator check)

    private func runSelfTest() async {
        var report: [String: Any] = [:]
        func note(_ key: String, _ value: Any?) {   // write the report after every step, so a stall still leaves evidence
            report[key] = value ?? "nil"
            let safe = report.mapValues { (item: Any) -> Any in JSONSerialization.isValidJSONObject([item]) ? item : String(describing: item) }
            if let folder = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
               let json = try? JSONSerialization.data(withJSONObject: safe, options: [.prettyPrinted, .sortedKeys]) {
                try? json.write(to: folder.appendingPathComponent("selftest.json"))
            }
        }
        let images = "return [...document.querySelectorAll('#image-select option')].map(o => o.textContent).join(' ; ')"
        try? await Task.sleep(nanoseconds: 2_500_000_000)
        note("1 app hooks", await run("return [!!window.REDLINE_MARKUP_STUDIO_NATIVE, typeof window.REDLINE_MARKUP_STUDIO_ADD, !document.getElementById('btn-paste').hidden].join(',')", timeout: 20))
        note("2 sample loaded", await run(images, timeout: 20))
        for (key, ext, mime) in [("3 open PDF", "pdf", "application/pdf"), ("4 open TIFF", "tif", "image/tiff")] {
            guard let url = Bundle.main.url(forResource: "selftest", withExtension: ext), let data = try? Data(contentsOf: url) else {
                note(key, "missing test file"); continue
            }
            note(key, await run("return String(await window.REDLINE_MARKUP_STUDIO_ADD(dataUrl, name)) + ' | ' + document.getElementById('status-toast').textContent",
                                ["dataUrl": dataURL(data, mime), "name": "selftest.\(ext)"], timeout: 60))
        }
        note("5 images", await run(images, timeout: 20))
        note("6 draw a box", await run("""
            const c = document.getElementById('paint-canvas'), r = c.getBoundingClientRect();
            const ev = (t, x, y) => c.dispatchEvent(new PointerEvent(t, { clientX: r.left + x, clientY: r.top + y, button: 0, pointerId: 1, pointerType: 'mouse', bubbles: true }));
            document.querySelector('[data-tool="rect"]').click();
            ev('pointerdown', r.width / 2 - 30, r.height / 2 - 20); ev('pointermove', r.width / 2 + 30, r.height / 2 + 20); ev('pointerup', r.width / 2 + 30, r.height / 2 + 20);
            await new Promise(done => setTimeout(done, 300));
            return document.getElementById('action-count').textContent + ' | ' + ([...document.querySelectorAll('#redline-log .ln')].pop() || {}).textContent;
            """, timeout: 20))
        for (key, radio) in [("7 save PNG", "save-png"), ("8 save PDF, all pages", "save-pdf")] {
            note(key, await run("""
                document.getElementById('btn-save').click(); document.getElementById(radio).checked = true;
                document.getElementById('save-form').requestSubmit();
                for (let i = 0; i < 150; i++) { await new Promise(done => setTimeout(done, 200)); if (document.getElementById('save-dlg').hidden) break; }
                return document.getElementById('save-dlg').hidden ? document.getElementById('status-toast').textContent : 'STUCK: ' + document.getElementById('save-status').textContent;
                """, ["radio": radio], timeout: 45))
        }
        note("9 files the app received", selfTestSaved)
        note("done", true)
    }

    // MARK: Scripts added to the page

    /// Gives the page `window.REDLINE_MARKUP_STUDIO_NATIVE`, which it uses in place of browser downloads and clipboard calls.
    private static let shim = #"""
    (function () {
      const app = window.webkit.messageHandlers.redline;
      const b64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
      const call = async (action, payload) => {
        const reply = await app.postMessage(Object.assign({ action }, payload || {}));
        if (reply && reply.error) { const e = new Error(reply.error); if (reply.error === 'cancelled') e.name = 'AbortError'; throw e; }
        return reply || {};
      };
      window.REDLINE_MARKUP_STUDIO_NATIVE = {
        platform: 'ios',
        save: async (filename, blob) => call('save', { filename, data: await b64(blob) }),
        share: async (files) => call('share', { files: await Promise.all(files.map(async (f) => ({ filename: f.filename, data: await b64(f.blob) }))) }),
        copyImage: async (blob) => call('copyImage', { data: await b64(blob) }),
        copyText: (text) => call('copyText', { text }),
        paste: () => call('paste'),
        fetch: (url) => call('fetch', { url }),
      };
    })();
    """#

    /// Stops the page itself from zooming when a field is tapped or the image is pinched; the studio zooms the image instead.
    private static let viewport = #"""
    (function () {
      const meta = document.querySelector('meta[name="viewport"]');
      if (meta) meta.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
    })();
    """#
}

extension StudioController: WKScriptMessageHandlerWithReply {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) async -> (Any?, String?) {
        guard let body = message.body as? [String: Any], let action = body["action"] as? String else {
            return (["error": "bad request"], nil)
        }
        return (await handle(action, body), nil)
    }
}

extension StudioController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        let queued = waiting
        waiting = []
        queued.forEach { open($0) }
        if selfTest { Task { await runSelfTest() } }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {   // iOS reclaimed the page's memory: start it again
        loaded = false
        loadStudio()
    }
}
