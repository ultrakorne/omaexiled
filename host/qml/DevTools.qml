// Chromium DevTools for one of the host's pages, in a normal window.
import QtQuick
import QtWebEngine

Window {
    id: root

    // The inspected WebEngineView and its name (overlay / settings / browser).
    required property var inspected
    required property string target

    title: "OmaExiled DevTools (" + target + ")"
    width: 1100
    height: 800
    visible: false

    onClosing: {
        devtools.inspectedView = null;
        host.devToolsClosed(target);
    }

    WebEngineView {
        id: devtools
        anchors.fill: parent
        inspectedView: root.inspected
    }
}
