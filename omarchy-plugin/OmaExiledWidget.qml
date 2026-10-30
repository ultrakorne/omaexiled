import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import qs.Ui

// OmaExiled bar widget: the Electron tray icon of Exiled Exchange 2
// (main/src/AppTray.ts), as an omarchy-shell bar widget. Left click opens
// the menu; right click opens the settings window (starting OmaExiled first
// when it is not running).
//
// Root is qs.Ui Panel (like omarchy.power / omarchy.tailscale): it supplies
// bar/moduleName/settings, setting(), opened/open()/close()/toggle(), and the
// popout-switch hooks KeyboardPanel and the bar expect. Exposing
// open/close/opened on the root is also what lets
// `omarchy-shell shell toggle omaexiled` reach this widget.
Panel {
  id: root
  moduleName: "omaexiled"
  // Panel's built-in IpcHandler would expose only open/close/toggle; this
  // widget registers its own read-only target below.
  manageIpc: false

  readonly property string home: Quickshell.env("HOME")
  readonly property color fg: bar ? bar.foreground : Commons.Color.foreground
  readonly property color dim: Qt.darker(fg, 1.4)
  readonly property color accentColor: Commons.Color.accent
  readonly property color urgentColor: bar ? bar.urgent : Commons.Color.urgent
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  // Inline settings from this widget's shell.json entry. The host does not
  // merge the manifest's `defaults`, so every read carries its own fallback.
  readonly property bool hideWhenStopped: setting("hideWhenStopped", false) === true
  readonly property string startCommand: String(setting("startCommand", "")) || "systemctl --user start omaexiled.service"
  readonly property string fallbackConfigDir: String(setting("configDir", "")) || (home + "/.config/omaexiled")

  readonly property bool running: backend.connected
  readonly property bool shown: !(hideWhenStopped && !running)
  readonly property string configDir: backend.configDir || fallbackConfigDir

  // Nerd Font "scale-balance" (nf-md-scale_balance): price checking, drawn
  // in the bar font like every first-party icon.
  readonly property string glyph: "\u{f05d1}"

  // Start: run `startCommand`, then wait for the backend to connect.
  property bool starting: false
  property int startExitCode: 0
  property string startStderr: ""
  readonly property string startError: startExitCode === 0 ? ""
    : "Start failed: " + (startStderr !== "" ? startStderr : "exit code " + startExitCode)
  readonly property string errorText: backend.error !== "" ? backend.error : startError

  readonly property string statusText: {
    if (running) return backend.gameDetected ? "Path of Exile 2 detected" : "Running · waiting for Path of Exile 2"
    return starting ? "Starting…" : "Not running"
  }

  // Same items as EE2 main/src/AppTray.ts, plus Start while stopped. `key`
  // is the letter that triggers the row while the menu has the keyboard.
  // Glyphs are Font Awesome codepoints from the bar's Nerd Font.
  readonly property var rows: running ? [
    { id: "settings", icon: "", label: "Settings / League", key: "s", enabled: true, separatorBefore: false },
    { id: "browser", icon: "", label: "Open in Browser", key: "b", enabled: backend.url !== "", separatorBefore: false },
    { id: "config", icon: "", label: "Open config folder", key: "c", enabled: true, separatorBefore: true },
    { id: "quit", icon: "", label: "Quit", key: "q", enabled: true, separatorBefore: false }
  ] : [
    { id: "start", icon: "", label: "Start OmaExiled", key: "s", enabled: !starting, separatorBefore: false },
    { id: "config", icon: "", label: "Open config folder", key: "c", enabled: true, separatorBefore: true }
  ]

  property int cursorIndex: 0
  property bool cursorActive: false

  // Detached: survives plugin hot-reload and shell restarts. `env -C` gives
  // the child a real cwd (Quickshell's own is qrc:/qs-blackhole).
  function launch(argv) {
    Quickshell.execDetached(["env", "-C", root.home].concat(argv))
  }

  function start() {
    if (running || starting) return
    startExitCode = 0
    startStderr = ""
    starting = true
    startTimeout.restart()
    startProc.running = true
  }

  function openSettings() {
    if (running) {
      backend.send({ type: "open-settings" })
    } else {
      backend.sendWhenConnected({ type: "open-settings" })
      start()
    }
  }

  function activate(id) {
    if (id === "settings") openSettings()
    else if (id === "browser") { if (backend.url !== "") launch(["xdg-open", backend.url]) }
    // The folder may not exist before the first run; create it so xdg-open
    // has something to show.
    else if (id === "config") launch(["sh", "-c", "mkdir -p -- \"$1\" && exec xdg-open \"$1\"", "sh", root.configDir])
    else if (id === "quit") backend.send({ type: "quit" })
    else if (id === "start") start()
    root.close()
  }

  function rowForKey(key) {
    for (var i = 0; i < rows.length; i++) if (rows[i].key === key) return i
    return -1
  }

  function moveCursor(delta) {
    if (!cursorActive) {
      cursorActive = true
      return
    }
    var i = cursorIndex
    for (var tries = 0; tries < rows.length; tries++) {
      i = Math.max(0, Math.min(rows.length - 1, i + delta))
      if (rows[i].enabled) break
    }
    cursorIndex = i
  }

  function activateCursor() {
    var row = rows[cursorIndex]
    if (cursorActive && row && row.enabled) activate(row.id)
  }

  onOpenedChanged: {
    if (opened) {
      cursorActive = false
      cursorIndex = 0
    } else if (!starting) {
      // Shown once; the backend does not repeat an error, and an unchanged
      // state is not re-sent, so nothing else would clear it.
      backend.error = ""
      startExitCode = 0
    }
  }
  onRowsChanged: if (cursorIndex >= rows.length) cursorIndex = 0
  onRunningChanged: if (running) {
    starting = false
    startTimeout.stop()
    startExitCode = 0
  }

  visible: shown
  implicitWidth: shown ? button.implicitWidth : 0
  implicitHeight: shown ? button.implicitHeight : 0

  ExiledBackend {
    id: backend
    socketPath: String(root.setting("socketPath", ""))
  }

  // Short-lived (systemctl returns once the unit is started), so a plain
  // child process is fine: if a plugin reload kills it, systemd still runs
  // the start job.
  Process {
    id: startProc
    command: ["env", "-C", root.home, "bash", "-lc", root.startCommand]
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.startStderr = text.trim().split("\n").pop()
    }
    onExited: function(exitCode) {
      root.startExitCode = exitCode
      if (exitCode !== 0) {
        root.starting = false
        startTimeout.stop()
      }
    }
  }

  // The backend writes shell.ready once it listens; give up waiting after
  // this long (the error text then says nothing, the status says stopped).
  Timer {
    id: startTimeout
    interval: 15000
    onTriggered: root.starting = false
  }

  // `omarchy-shell omaexiled status`. One bar copy per monitor registers the
  // same target and only one of them receives calls; every copy reads the
  // same backend, so the answer does not depend on which one it is.
  IpcHandler {
    target: "omaexiled"

    function status(): string {
      return JSON.stringify({
        running: root.running,
        starting: root.starting,
        error: root.errorText,
        socket: backend.path,
        hello: backend.hello,
        state: backend.state
      })
    }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.glyph
    // Stopped: dimmed. Running: bar foreground. PoE2 detected: accent.
    dimmed: !root.running
    active: root.running && backend.gameDetected
    useActiveColor: true
    activeColor: root.accentColor
    tooltipText: root.running
      ? "OmaExiled" + (backend.version !== "" ? " " + backend.version : "")
        + (backend.league !== "" ? " · " + backend.league : "")
        + (backend.gameDetected ? " · Path of Exile 2 detected" : "")
      : "OmaExiled is not running"
    onPressed: function(b) {
      if (b === Qt.RightButton) root.openSettings()
      else root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(300))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) { root.moveCursor(dy !== 0 ? dy : dx) }
      onActivateRequested: root.activateCursor()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        var index = root.rowForKey(String(t).toLowerCase())
        if (index >= 0 && root.rows[index].enabled) root.activate(root.rows[index].id)
      }

      Column {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(12)

        PanelHero {
          width: parent.width
          title: "OmaExiled"
          meta: root.statusText
          detail: root.running ? backend.league : ""
          foreground: root.fg
          fontFamily: root.fontFamily
          iconOpacity: root.running ? 1.0 : 0.5
          iconComponent: Component {
            Text {
              textFormat: Text.PlainText
              text: root.glyph
              color: root.running && backend.gameDetected ? root.accentColor : root.fg
              font.family: root.fontFamily
              font.pixelSize: Style.font.display
            }
          }
        }

        Text {
          visible: root.errorText !== ""
          width: parent.width
          textFormat: Text.PlainText
          text: root.errorText
          color: root.urgentColor
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WordWrap
        }

        Column {
          visible: root.running
          width: parent.width
          spacing: Style.spacing.labelGap

          InfoPair { label: "Overlay key"; value: backend.overlayKey || "—" }
          InfoPair { label: "Version"; value: backend.version || "—" }
        }

        PanelSeparator {
          foreground: root.fg
        }

        Column {
          width: parent.width
          spacing: Style.space(4)

          Repeater {
            model: root.rows
            delegate: MenuRow { }
          }
        }
      }
    }
  }

  component InfoPair: Item {
    property string label: ""
    property string value: ""

    width: parent ? parent.width : 0
    implicitHeight: Math.max(infoLabel.implicitHeight, infoValue.implicitHeight)

    Text {
      id: infoLabel
      anchors.left: parent.left
      textFormat: Text.PlainText
      text: parent.label
      color: root.fg
      opacity: 0.6
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
    }

    Text {
      id: infoValue
      anchors.right: parent.right
      width: Math.min(implicitWidth, parent.width - infoLabel.implicitWidth - Style.space(8))
      horizontalAlignment: Text.AlignRight
      textFormat: Text.PlainText
      text: parent.value
      color: root.fg
      elide: Text.ElideRight
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
    }
  }

  component MenuRow: Column {
    id: menuRow
    required property var modelData
    required property int index

    width: parent ? parent.width : 0
    spacing: Style.space(4)

    PanelSeparator {
      visible: menuRow.modelData.separatorBefore === true
      foreground: root.fg
    }

    CursorSurface {
      width: parent.width
      implicitHeight: label.implicitHeight + Style.spacing.xl
      foreground: root.fg
      hasCursor: root.cursorActive && root.cursorIndex === menuRow.index
      opacity: menuRow.modelData.enabled ? 1.0 : 0.45

      Text {
        id: icon
        anchors.left: parent.left
        anchors.leftMargin: Style.space(6)
        anchors.verticalCenter: parent.verticalCenter
        width: Style.space(22)
        horizontalAlignment: Text.AlignHCenter
        textFormat: Text.PlainText
        text: menuRow.modelData.icon
        color: menuRow.modelData.id === "quit" ? root.urgentColor : root.fg
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
      }

      Text {
        id: label
        anchors.left: icon.right
        anchors.leftMargin: Style.space(8)
        anchors.right: keyHint.left
        anchors.rightMargin: Style.space(8)
        anchors.verticalCenter: parent.verticalCenter
        textFormat: Text.PlainText
        text: menuRow.modelData.label
        color: root.fg
        elide: Text.ElideRight
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
      }

      // The letter that triggers this row (PanelKeyCatcher textKey).
      Text {
        id: keyHint
        anchors.right: parent.right
        anchors.rightMargin: Style.space(8)
        anchors.verticalCenter: parent.verticalCenter
        textFormat: Text.PlainText
        text: menuRow.modelData.key.toUpperCase()
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        font.bold: true
      }

      MouseArea {
        anchors.fill: parent
        hoverEnabled: true
        enabled: menuRow.modelData.enabled
        cursorShape: Qt.PointingHandCursor
        onEntered: {
          root.cursorActive = true
          root.cursorIndex = menuRow.index
        }
        onClicked: root.activate(menuRow.modelData.id)
      }
    }
  }
}
