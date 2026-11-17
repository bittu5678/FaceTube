package online.facetube.app;

import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {

    @Override
    protected void load() {
        super.load();
        if (this.bridge != null) {
            this.bridge.setWebViewClient(
                new BridgeWebViewClient(this.bridge) {
                    @Override
                    public void onReceivedHttpError(
                        WebView view,
                        WebResourceRequest request,
                        WebResourceResponse errorResponse
                    ) {
                        if (request != null && request.isForMainFrame()) {
                            // Do not call super.onReceivedHttpError(...) for main-frame HTTP >= 400
                            // responses, so normal 404/500 pages are not replaced by offline.html.
                            return;
                        }
                        super.onReceivedHttpError(view, request, errorResponse);
                    }
                }
            );
        }
    }
}
