// The settings window: a normal toplevel (app_id "omaexiled"). Closing it
// hides it; the backend hears about it as window.closed, and the host
// replaces the window on the next open (see Host::windowClosed).
import QtQuick

Window {
    id: root

    property alias view: view

    function dismiss() {
        root.hide();
        host.windowClosed("settings");
    }

    title: "OmaExiled Settings"
    width: 1000
    height: 760
    minimumWidth: 640
    minimumHeight: 480
    visible: false
    color: "#111827"

    onClosing: event => {
        event.accepted = false;
        root.dismiss();
    }

    AppView {
        id: view
        anchors.fill: parent
        page: "settings"
        backgroundColor: root.color
        onWindowCloseRequested: root.dismiss()
    }
}
