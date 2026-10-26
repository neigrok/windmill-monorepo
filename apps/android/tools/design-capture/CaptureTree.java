package works.windmill.capture;

import android.app.UiAutomation;
import android.graphics.Rect;
import android.util.Xml;
import android.view.accessibility.AccessibilityNodeInfo;
import java.io.FileOutputStream;
import org.xmlpull.v1.XmlSerializer;

public final class CaptureTree {
    public static void main(String[] args) {
        try {
            Class<?> bridge = Class.forName("com.android.uiautomator.core.UiAutomationShellWrapper");
            Object wrapper = bridge.getConstructor().newInstance();
            bridge.getMethod("connect").invoke(wrapper);
            try {
                UiAutomation automation = (UiAutomation) bridge.getMethod("getUiAutomation").invoke(wrapper);
                AccessibilityNodeInfo root = null;
                long deadline = android.os.SystemClock.uptimeMillis() + 3000;
                while (root == null && android.os.SystemClock.uptimeMillis() < deadline) {
                    root = automation.getRootInActiveWindow();
                    if (root == null) android.os.SystemClock.sleep(50);
                }
                if (root == null) throw new IllegalStateException("Capture has no active accessibility root");
                try (FileOutputStream out = new FileOutputStream("/data/local/tmp/design-capture.xml")) {
                    XmlSerializer xml = Xml.newSerializer();
                    xml.setOutput(out, "UTF-8");
                    xml.startDocument("UTF-8", true);
                    xml.startTag(null, "hierarchy");
                    node(xml, root);
                    xml.endTag(null, "hierarchy");
                    xml.endDocument();
                }
            } finally {
                bridge.getMethod("disconnect").invoke(wrapper);
            }
        } catch (Exception failure) {
            System.err.println("Capture hierarchy failed: " + failure.getClass().getSimpleName());
            System.exit(1);
        }
    }
    private static void node(XmlSerializer xml, AccessibilityNodeInfo value) throws Exception {
        xml.startTag(null, "node");
        xml.attribute(null, "text", value.getText() == null ? "" : value.getText().toString());
        xml.attribute(null, "content-desc", value.getContentDescription() == null ? "" : value.getContentDescription().toString());
        xml.attribute(null, "state-desc", value.getStateDescription() == null ? "" : value.getStateDescription().toString());
        xml.attribute(null, "resource-id", value.getViewIdResourceName() == null ? "" : value.getViewIdResourceName());
        xml.attribute(null, "class", value.getClassName() == null ? "" : value.getClassName().toString());
        xml.attribute(null, "package", value.getPackageName() == null ? "" : value.getPackageName().toString());
        xml.attribute(null, "enabled", Boolean.toString(value.isEnabled()));
        xml.attribute(null, "clickable", Boolean.toString(value.isClickable()));
        xml.attribute(null, "checked", Boolean.toString(value.isChecked()));
        xml.attribute(null, "selected", Boolean.toString(value.isSelected()));
        xml.attribute(null, "visible-to-user", Boolean.toString(value.isVisibleToUser()));
        Rect bounds = new Rect(); value.getBoundsInScreen(bounds);
        xml.attribute(null, "bounds", bounds.toShortString());
        for (int i = 0; i < value.getChildCount(); i++) {
            AccessibilityNodeInfo child = value.getChild(i);
            if (child != null) node(xml, child);
        }
        xml.endTag(null, "node");
    }
}
