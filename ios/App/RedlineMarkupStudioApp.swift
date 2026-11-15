import SwiftUI
import WebKit

/// Redline_markup_studio for iPhone and iPad.
/// The studio itself is the same page the Claude plugin uses; this app hosts it and gives it
/// the iOS share sheet, the clipboard, web image loading and "Open in" from other apps.
@main
struct RedlineMarkupStudioApp: App {
    @StateObject private var studio = StudioController()

    var body: some Scene {
        WindowGroup {
            ZStack {
                Color(red: 15 / 255, green: 23 / 255, blue: 42 / 255).ignoresSafeArea()
                StudioView(studio: studio).ignoresSafeArea(.keyboard, edges: .bottom)
            }
            .preferredColorScheme(.dark)
            .onOpenURL { studio.open($0) }
        }
    }
}

struct StudioView: UIViewRepresentable {
    let studio: StudioController

    func makeUIView(context: Context) -> WKWebView { studio.webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
