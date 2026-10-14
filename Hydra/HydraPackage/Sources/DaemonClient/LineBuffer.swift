import Foundation

/// Accumulates raw bytes and yields complete newline-delimited lines.
///
/// A JSON line from the daemon can be large (e.g. full conversation history),
/// so this buffer handles partial reads, multi-line chunks, and empty lines
/// without allocating unnecessarily.
struct LineBuffer: Sendable {
    private var buffer = Data()

    /// Appends `data` to the internal buffer and returns all complete lines
    /// (without their trailing newline byte). Empty lines are discarded.
    mutating func append(_ data: Data) -> [Data] {
        buffer.append(data)
        var lines: [Data] = []
        while let newlineOffset = buffer.firstIndex(of: UInt8(ascii: "\n")) {
            let lineSlice = buffer[buffer.startIndex..<newlineOffset]
            if !lineSlice.isEmpty {
                lines.append(Data(lineSlice))
            }
            buffer.removeSubrange(buffer.startIndex...newlineOffset)
        }
        return lines
    }

    /// Resets the buffer, discarding any partial line.
    mutating func reset() {
        buffer = Data()
    }
}
