import Foundation

private let allowedLinkSchemes: Set<String> = ["http", "https", "mailto"]

/// Renders inline Markdown (whitespace preserved) for chat text.
/// Links with schemes other than http, https or mailto lose their `.link` attribute.
public func renderedMarkdown(_ text: String) -> AttributedString {
    var result: AttributedString
    do {
        result = try AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )
    } catch {
        return AttributedString(text)
    }
    for run in result.runs {
        guard let url = run.link else { continue }
        if !allowedLinkSchemes.contains(url.scheme?.lowercased() ?? "") {
            result[run.range].link = nil
        }
    }
    return result
}

/// Plain-text preview with Markdown syntax stripped.
public func plainPreview(_ text: String) -> String {
    String(renderedMarkdown(text).characters)
}
