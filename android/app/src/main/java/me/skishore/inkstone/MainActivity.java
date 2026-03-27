package me.skishore.inkstone;

import android.os.Bundle;
import android.view.View;
import android.webkit.ValueCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Capacitor sets LAYOUT_FULLSCREEN which draws the WebView behind the
        // system status bar. Clear that flag so the WebView starts below it.
        View decorView = getWindow().getDecorView();
        decorView.setSystemUiVisibility(
            decorView.getSystemUiVisibility()
            & ~View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        );
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        getBridge().getWebView().evaluateJavascript(
            "(function() {" +
            "  try { return Router.current().route.getName(); }" +
            "  catch(e) { return 'unknown'; }" +
            "})()",
            new ValueCallback<String>() {
                @Override
                public void onReceiveValue(String route) {
                    if (route != null && (route.contains("index") || route.contains("unknown"))) {
                        MainActivity.super.onBackPressed();
                    } else {
                        getBridge().getWebView().evaluateJavascript(
                            "Router.go('/')", null);
                    }
                }
            }
        );
    }
}
