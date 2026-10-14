import TipKit

/// Points at the sidebar "+" button until the user has created (or tried to create) a first bot.
struct NewBotTip: Tip {
    @Parameter(.transient)
    static var isEligible: Bool = false

    var title: Text { Text("Create a bot") }
    var message: Text? { Text("Give it a name and one job to do.") }

    var rules: [Rule] {
        #Rule(Self.$isEligible) { $0 == true }
    }
}
