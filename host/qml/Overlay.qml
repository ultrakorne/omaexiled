// The overlay page. The host makes this window a layer surface
// (src/overlay.cpp) and only shows it while the page has something to show.
import QtQuick

Window {
    property alias view: view

    visible: false
    color: "transparent"
    flags: Qt.FramelessWindowHint

    AppView {
        id: view
        anchors.fill: parent
        page: "overlay"
        backgroundColor: "transparent"
        // Nothing (not even a Chromium error page) may cover the game.
        settings.errorPageEnabled: false
        settings.showScrollBars: false
    }
}
