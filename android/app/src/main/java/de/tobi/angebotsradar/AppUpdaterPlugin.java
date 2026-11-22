package de.tobi.angebotsradar;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** Reads the installed version and downloads + opens a newer APK from GitHub Releases. */
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {

    @PluginMethod
    public void getVersion(PluginCall call) {
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            JSObject ret = new JSObject();
            ret.put("versionName", info.versionName);
            ret.put("versionCode", Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        final String url = call.getString("url");
        if (url == null) { call.reject("url fehlt"); return; }

        if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName()));
            s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(s);
            JSObject ret = new JSObject();
            ret.put("status", "permission");
            call.resolve(ret);
            return;
        }

        new Thread(() -> {
            try {
                File dir = new File(getContext().getCacheDir(), "updates");
                dir.mkdirs();
                File apk = new File(dir, "update.apk");
                String current = url;
                HttpURLConnection con = null;
                for (int i = 0; i < 6; i++) {
                    con = (HttpURLConnection) new URL(current).openConnection();
                    con.setInstanceFollowRedirects(false);
                    con.setConnectTimeout(20000);
                    con.setReadTimeout(60000);
                    int code = con.getResponseCode();
                    if (code >= 300 && code < 400) {
                        current = new URL(new URL(current), con.getHeaderField("Location")).toString();
                        con.disconnect();
                        continue;
                    }
                    if (code != 200) throw new Exception("HTTP " + code);
                    break;
                }
                try (InputStream in = con.getInputStream(); FileOutputStream out = new FileOutputStream(apk)) {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
                con.disconnect();

                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
                Intent install = new Intent(Intent.ACTION_VIEW);
                install.setDataAndType(uri, "application/vnd.android.package-archive");
                install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(install);

                JSObject ret = new JSObject();
                ret.put("status", "installing");
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Download fehlgeschlagen: " + e.getMessage());
            }
        }).start();
    }
}
