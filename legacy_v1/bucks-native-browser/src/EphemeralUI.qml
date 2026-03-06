import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtQuick.Effects

Item {
    id: ephemeralRoot
    anchors.fill: parent
    visible: opacity > 0
    opacity: 0
    z: 1000

    property string currentResponse: ""
    property alias searchText: inputField.text

    Behavior on opacity { NumberAnimation { duration: 250; easing.type: Easing.OutQuad } }

    function show() {
        opacity = 1
        inputField.forceActiveFocus()
    }

    function hide() {
        opacity = 0
        inputField.text = ""
        currentResponse = ""
    }

    // Blurred Background Overlay
    Rectangle {
        anchors.fill: parent
        color: Qt.rgba(0, 0, 0, 0.4)
        
        MouseArea {
            anchors.fill: parent
            onClicked: ephemeralRoot.hide()
        }
    }

    // Main Command Container
    Rectangle {
        id: container
        width: Math.min(600, parent.width - 40)
        height: Math.min(450, parent.height - 100)
        anchors.centerIn: parent
        color: "#0a0a0f"
        radius: 24
        border.color: Qt.rgba(1, 1, 1, 0.1)
        border.width: 1

        // Glass Glow Effect
        Rectangle {
            anchors.fill: parent
            color: "transparent"
            radius: 24
            border.color: "#3B82F6"
            border.width: 2
            opacity: slmInterface.isProcessing ? 0.3 : 0.1
            
            Behavior on opacity { NumberAnimation { duration: 500 } }
        }

        ColumnLayout {
            anchors.fill: parent
            anchors.margins: 24
            spacing: 20

            // Input Bar
            RowLayout {
                spacing: 16
                
                Rectangle {
                    width: 40; height: 40; radius: 20
                    color: slmInterface.isProcessing ? "#3B82F6" : Qt.rgba(1, 1, 1, 0.05)
                    
                    Text {
                        anchors.centerIn: parent
                        text: "" // Mic icon
                        font.family: "MaterialIcons-Regular"
                        font.pixelSize: 20
                        color: "white"
                    }

                    Behavior on color { ColorAnimation { duration: 200 } }
                }

                TextField {
                    id: inputField
                    Layout.fillWidth: true
                    placeholderText: "Ask Bucks AI..."
                    color: "white"
                    font.family: "Inter"
                    font.pixelSize: 18
                    background: null
                    onAccepted: {
                        currentResponse = ""
                        slmInterface.query(text)
                    }
                }

                RoundButton {
                    text: "" // Search icon
                    font.family: "MaterialIcons-Regular"
                    width: 40; height: 40
                    palette.buttonText: "white"
                    background: Rectangle { color: "transparent"; radius: 20 }
                    onClicked: inputField.accepted()
                }
            }

            // Results Area
            ScrollView {
                Layout.fillWidth: true
                Layout.fillHeight: true
                clip: true
                
                Text {
                    id: responseText
                    width: parent.width
                    text: currentResponse || (slmInterface.isProcessing ? "Thinking..." : "How can I help you today?")
                    color: currentResponse ? "white" : "#666"
                    font.family: "Inter"
                    font.pixelSize: 15
                    lineHeight: 1.4
                    wrapMode: Text.Wrap
                }
            }

            // Quick Actions (Predictive)
            RowLayout {
                Layout.fillWidth: true
                spacing: 12
                visible: !slmInterface.isProcessing

                Button {
                    text: " Summarize"
                    font.family: "MaterialIcons-Regular"
                    contentItem: Text { text: parent.text; color: "white"; font.pixelSize: 12; horizontalAlignment: Text.AlignHCenter }
                    background: Rectangle { color: Qt.rgba(1, 1, 1, 0.05); radius: 10; border.color: Qt.rgba(1, 1, 1, 0.1) }
                }
                Button {
                    text: " Help"
                    font.family: "MaterialIcons-Regular"
                    contentItem: Text { text: parent.text; color: "white"; font.pixelSize: 12; horizontalAlignment: Text.AlignHCenter }
                    background: Rectangle { color: Qt.rgba(1, 1, 1, 0.05); radius: 10; border.color: Qt.rgba(1, 1, 1, 0.1) }
                }
                Item { Layout.fillWidth: true }
                Text {
                    text: "Qwen-2.5 0.5B Offline"
                    color: "#444"
                    font.family: "Outfit"
                    font.pixelSize: 10
                }
            }
        }
    }

    // Connect to C++ Signals
    Connections {
        target: slmInterface
        function onTokenReceived(token) {
            currentResponse += token
        }
    }

    // Global Shortcut Listener (External trigger)
    Shortcut {
        sequences: ["Ctrl+K", "StandardKey.Find"]
        onActivated: {
            if (ephemeralRoot.opacity > 0) hide()
            else show()
        }
    }
}
