import ComposableArchitecture
import DaemonClient
import Foundation
import SwiftUI

// MARK: - NewBotFeature

@Reducer
public struct NewBotFeature {

    // MARK: - State

    @ObservableState
    public struct State: Equatable {
        public var name: String = ""
        public var instructions: String = ""
        public var selectedModel: String = ""
        public var availableModels: [ModelDescriptor] = []
        public var isLoading: Bool = false
        public var nameError: String?
        public var errorMessage: String?

        public init() {}
    }

    // MARK: - Action

    public enum Action: BindableAction {
        case binding(BindingAction<State>)
        case task
        case modelsLoaded([ModelDescriptor])
        case modelsLoadFailed(String)
        case createButtonTapped
        case _createResponse(Result<Bot, any Error>)
        case cancelButtonTapped
        case delegate(Delegate)

        public enum Delegate: Equatable {
            case botCreated(Bot)
        }
    }

    // MARK: - Dependencies

    @Dependency(\.daemonClient) var daemonClient
    @Dependency(\.dismiss) var dismiss

    // MARK: - Init

    public init() {}

    // MARK: - Body

    public var body: some Reducer<State, Action> {
        BindingReducer()
        Reduce { state, action in
            switch action {

            case .binding:
                return .none

            case .task:
                let client = daemonClient
                return .run { send in
                    do {
                        let models = try await client.modelsList()
                        await send(.modelsLoaded(models))
                    } catch {
                        await send(.modelsLoadFailed(error.localizedDescription))
                    }
                }

            case .modelsLoaded(let models):
                state.availableModels = models
                if state.selectedModel.isEmpty {
                    let defaultModel = models.first(where: { $0.default }) ?? models.first
                    if let m = defaultModel {
                        state.selectedModel = "\(m.provider)/\(m.modelID)"
                    }
                }
                return .none

            case .modelsLoadFailed(let message):
                state.errorMessage = message
                return .none

            case .createButtonTapped:
                let name = state.name.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !name.isEmpty else {
                    state.nameError = "Name is required."
                    return .none
                }
                state.nameError = nil
                state.errorMessage = nil
                state.isLoading = true
                let model: String? = state.selectedModel.isEmpty ? nil : state.selectedModel
                let instructions = state.instructions
                let client = daemonClient
                return .run { send in
                    do {
                        let bot = try await client.botsCreate(name, instructions, model)
                        await send(._createResponse(.success(bot)))
                    } catch {
                        await send(._createResponse(.failure(error)))
                    }
                }

            case ._createResponse(.success(let bot)):
                state.isLoading = false
                return .send(.delegate(.botCreated(bot)))

            case ._createResponse(.failure(let error)):
                state.isLoading = false
                state.errorMessage = error.localizedDescription
                return .none

            case .cancelButtonTapped:
                let dismiss = dismiss
                return .run { _ in await dismiss() }

            case .delegate:
                // Handled by parent
                return .none
            }
        }
    }
}

// MARK: - NewBotFeatureView

public struct NewBotFeatureView: View {
    @Bindable var store: StoreOf<NewBotFeature>

    public init(store: StoreOf<NewBotFeature>) {
        self.store = store
    }

    public var body: some View {
        NavigationStack {
            Form {
                Section("Bot Name") {
                    TextField("My Bot", text: $store.name)
                    if let nameError = store.nameError {
                        Text(nameError)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }

                Section("Instructions (optional)") {
                    TextEditor(text: $store.instructions)
                        .frame(minHeight: 80)
                }

                if store.availableModels.count > 1 {
                    Section("Model") {
                        Picker("Model", selection: $store.selectedModel) {
                            ForEach(store.availableModels, id: \.modelID) { model in
                                Text(model.name).tag("\(model.provider)/\(model.modelID)")
                            }
                        }
                        .pickerStyle(.menu)
                    }
                }

                if let error = store.errorMessage {
                    Section {
                        Text(error)
                            .foregroundStyle(.red)
                            .font(.subheadline)
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("New Bot")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { store.send(.cancelButtonTapped) }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if store.isLoading {
                        ProgressView()
                    } else {
                        Button("Create") { store.send(.createButtonTapped) }
                            .disabled(store.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
            .task { await store.send(.task).finish() }
        }
    }
}
