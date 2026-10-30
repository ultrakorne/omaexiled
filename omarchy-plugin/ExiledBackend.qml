import QtQuick
import Quickshell
import Quickshell.Io

// One connection from a bar-widget instance to the OmaExiled backend.
// Transport: Unix stream socket, newline-delimited JSON; the backend sends
// `hello` and then a full `state` on connect and on every change (see
// docs/port-notes/09-omarchy-shell-plugin.md §8 and DESIGN.md).
QtObject {
  id: backend

  property string socketPath: ""
  readonly property string runtimeDir: Quickshell.env("XDG_RUNTIME_DIR") || "/tmp"
  readonly property string path: socketPath !== "" ? socketPath : runtimeDir + "/omaexiled/shell.sock"
  // Written by the backend once the socket listens (same directory as the socket).
  readonly property string readyPath: path.substring(0, path.lastIndexOf("/")) + "/shell.ready"

  property var hello: null
  property var state: null
  property string error: ""

  // A state message has arrived on a live connection: the backend is up.
  readonly property bool connected: state !== null
  readonly property bool gameDetected: !!state && state.gameDetected === true
  readonly property bool gameFocused: !!state && state.gameFocused === true
  readonly property string league: state && state.league ? String(state.league) : ""
  readonly property string overlayKey: state && state.overlayKey ? String(state.overlayKey) : ""
  readonly property string url: state && state.url ? String(state.url) : ""
  readonly property string configDir: state && state.configDir ? String(state.configDir) : ""
  readonly property string version: hello && hello.version ? String(hello.version) : ""

  // A command queued while the backend is down (right click → start, then
  // settings). Sent on the next `state`, dropped after `pendingTimeout`.
  property var pending: null
  property int pendingTimeout: 20000

  function receive(line) {
    var message
    try {
      message = JSON.parse(line)
    } catch (e) {
      error = "Unreadable message from OmaExiled"
      return
    }
    if (message.v !== 1) {
      error = "OmaExiled speaks protocol " + message.v + "; this widget speaks 1"
      return
    }
    if (message.type === "hello") hello = message
    else if (message.type === "state") {
      state = message
      error = ""
      flushPending()
    } else if (message.type === "error") error = String(message.message || "")
  }

  function send(command) {
    if (!socket || !socket.connected) return false
    socket.write(JSON.stringify(Object.assign({ v: 1 }, command)) + "\n")
    socket.flush()
    return true
  }

  function sendWhenConnected(command) {
    if (connected && send(command)) return
    pending = command
    pendingExpiry.restart()
  }

  function flushPending() {
    if (!pending) return
    var command = pending
    pending = null
    pendingExpiry.stop()
    send(command)
  }

  function reconnectNow() {
    var previous = socket
    socketFailed = false
    socket = socketFactory.createObject(backend)
    if (previous) previous.destroy()
  }

  // The current socket's connect failed or its connection dropped (as
  // opposed to still connecting).
  property bool socketFailed: false

  property Component socketFactory: Component {
    Socket {
      path: backend.path
      connected: true
      parser: SplitParser {
        onRead: function(line) { backend.receive(line) }
      }
      // Only the current socket can fail or drop: sockets are replaced only
      // when not connected. A failed connect may report its error during
      // createObject(), before `socket` is assigned.
      onError: backend.socketFailed = true
      onConnectedChanged: {
        if (connected) {
          backend.retryDelay = 1000
        } else {
          backend.socketFailed = true
          backend.state = null
          backend.hello = null
        }
      }
    }
  }

  // A Socket whose connect failed cannot be retried by toggling `connected`
  // (omastorm ui/Engine.qml); a fresh object is created instead.
  property var socket: socketFactory.createObject(backend)

  // Back off while the backend is down: every failed connect logs a
  // "quickshell.io.socket ... ServerNotFoundError" warning to the shell log.
  property int retryDelay: 1000
  property Timer reconnect: Timer {
    interval: backend.retryDelay
    repeat: true
    running: !backend.socket || !backend.socket.connected
    onTriggered: {
      backend.retryDelay = Math.min(30000, backend.retryDelay * 2)
      backend.reconnectNow()
    }
  }

  property Timer pendingExpiry: Timer {
    interval: backend.pendingTimeout
    onTriggered: backend.pending = null
  }

  // The backend writes its pid to shell.ready once its socket listens; a new
  // pid means a new backend, so connect at once instead of waiting out the
  // back-off. A stale file (crashed backend) keeps its pid and is ignored, and
  // a socket that is still connecting is left alone.
  property string readyStamp: ""

  function readyChanged(text) {
    if (text === readyStamp) return
    readyStamp = text
    if (text !== "" && socketFailed) {
      retryDelay = 1000
      reconnectNow()
    }
  }

  property FileView readyFile: FileView {
    path: backend.readyPath
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: backend.readyChanged(text().trim())
    onLoadFailed: backend.readyChanged("")
  }

  // FileView cannot watch a directory that does not exist yet (the backend
  // creates it on its first start), so re-read shell.ready every 2 s while
  // disconnected. Reading a missing file is silent, unlike a failed connect.
  property Timer readyPoll: Timer {
    interval: 2000
    repeat: true
    running: !backend.connected
    onTriggered: backend.readyFile.reload()
  }
}
