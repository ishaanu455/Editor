package com.aegisx.editor;

import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.text.InputType;
import android.util.Base64;
import android.webkit.CookieManager;
import android.webkit.HttpAuthHandler;
import android.webkit.URLUtil;
import android.webkit.WebView;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Toast;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

import java.nio.charset.StandardCharsets;

public class MainActivity extends BridgeActivity {
  private static final String PREFS = "aegis_auth";
  private boolean triedSaved = false;

  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    WebView wv = getBridge().getWebView();

    // nginx Basic Auth: ask once, remember the login
    wv.setWebViewClient(new BridgeWebViewClient(getBridge()) {
      @Override
      public void onReceivedHttpAuthRequest(WebView view, final HttpAuthHandler handler, String host, String realm) {
        SharedPreferences sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String u = sp.getString("u", null);
        String p = sp.getString("p", null);
        if (u != null && p != null && !triedSaved) {
          triedSaved = true;
          handler.proceed(u, p);
          return;
        }
        LinearLayout box = new LinearLayout(MainActivity.this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(48, 24, 48, 0);
        final EditText user = new EditText(MainActivity.this);
        user.setHint("Username");
        final EditText pass = new EditText(MainActivity.this);
        pass.setHint("Password");
        pass.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        box.addView(user);
        box.addView(pass);
        new AlertDialog.Builder(MainActivity.this)
          .setTitle("AegisX login")
          .setView(box)
          .setCancelable(false)
          .setPositiveButton("Login", (d, w) -> {
            String nu = user.getText().toString();
            String np = pass.getText().toString();
            getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("u", nu).putString("p", np).apply();
            triedSaved = true;
            handler.proceed(nu, np);
          })
          .setNegativeButton("Cancel", (d, w) -> handler.cancel())
          .show();
      }

      @Override
      public void onPageFinished(WebView view, String url) {
        super.onPageFinished(view, url);
        triedSaved = false;
      }
    });

    // Export download (<a download>) -> Android DownloadManager -> Downloads folder
    wv.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
      try {
        String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
        DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
        req.setMimeType(mimeType);
        req.addRequestHeader("User-Agent", userAgent);
        String cookie = CookieManager.getInstance().getCookie(url);
        if (cookie != null) req.addRequestHeader("Cookie", cookie);
        SharedPreferences sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String u = sp.getString("u", null);
        String p = sp.getString("p", null);
        if (u != null && p != null) {
          String token = Base64.encodeToString((u + ":" + p).getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
          req.addRequestHeader("Authorization", "Basic " + token);
        }
        req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
        ((DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE)).enqueue(req);
        Toast.makeText(this, "Downloading " + name, Toast.LENGTH_SHORT).show();
      } catch (Exception e) {
        Toast.makeText(this, "Download failed: " + e.getMessage(), Toast.LENGTH_LONG).show();
      }
    });
  }
}
