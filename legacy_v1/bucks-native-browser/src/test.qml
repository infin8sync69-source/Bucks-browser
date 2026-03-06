import QtQuick
import QtQuick.Window

Window {
    visible: true
    width: 600
    height: 400
    title: "Bucks RENDERING TEST"
    color: "red"

    Text {
        anchors.centerIn: parent
        text: "IF YOU SEE THIS, RENDERING WORKS"
        color: "white"
        font.pixelSize: 24
    }
}
