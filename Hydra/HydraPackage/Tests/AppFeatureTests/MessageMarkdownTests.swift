import AppFeature
import Foundation
import Testing

@Suite struct MessageMarkdownTests {
    @Test func inlineStylesProducePresentationIntents() {
        let out = renderedMarkdown("**bold** *ital* `code`")
        let intents = out.runs.compactMap(\.inlinePresentationIntent)
        #expect(intents.contains(.stronglyEmphasized))
        #expect(intents.contains(.emphasized))
        #expect(intents.contains(.code))
    }

    @Test func bareAndMarkdownLinksAreLinks() {
        let bare = renderedMarkdown("see https://example.com/a now")
        #expect(bare.runs.contains { $0.link?.absoluteString == "https://example.com/a" })
        let md = renderedMarkdown("[site](https://example.com)")
        #expect(md.runs.contains { $0.link?.absoluteString == "https://example.com" })
        #expect(String(md.characters) == "site")
    }

    @Test func unsafeSchemesAreNotLinksButKeepText() {
        for raw in ["[x](file:///etc/passwd)", "[x](javascript:alert(1))", "[x](myapp://open)"] {
            let out = renderedMarkdown(raw)
            #expect(out.runs.allSatisfy { $0.link == nil })
            #expect(String(out.characters) == "x")
        }
    }

    @Test func mailtoLinkIsKept() {
        let out = renderedMarkdown("[mail](mailto:a@example.com)")
        #expect(out.runs.contains { $0.link != nil })
    }

    @Test func newlinesAndListLinesPreserved() {
        let text = "intro\n\n- one\n- two"
        #expect(String(renderedMarkdown(text).characters) == text)
    }

    @Test func malformedMarkdownDoesNotCrash() {
        let out = String(renderedMarkdown("**open").characters)
        #expect(out == "**open")
    }

    @Test func plainPreviewStripsSyntax() {
        #expect(plainPreview("**bold** and `code`") == "bold and code")
    }
}
