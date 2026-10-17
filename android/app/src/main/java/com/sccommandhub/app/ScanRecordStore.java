package com.sccommandhub.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;

public class ScanRecordStore {

    private static final String TAG = "ScanRecordStore";
    private static final String PREFS_NAME = "TextScannerPrefs";
    private static final String KEY_SCAN_RECORDS = "scan_records";

    private static SharedPreferences getPrefs(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public static synchronized JSObject addRecord(Context context, String text, int blockCount) {
        JSObject record = new JSObject();
        String id = UUID.randomUUID().toString();

        SimpleDateFormat isoFormat = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        isoFormat.setTimeZone(TimeZone.getTimeZone("UTC"));
        String timestamp = isoFormat.format(new Date());

        record.put("id", id);
        record.put("text", text);
        record.put("blockCount", blockCount);
        record.put("timestamp", timestamp);

        SharedPreferences prefs = getPrefs(context);
        String existingJson = prefs.getString(KEY_SCAN_RECORDS, "[]");

        try {
            JSONArray jsonArray = new JSONArray(existingJson);
            JSONObject newObject = new JSONObject();
            newObject.put("id", id);
            newObject.put("text", text);
            newObject.put("blockCount", blockCount);
            newObject.put("timestamp", timestamp);

            // Add new scan at beginning of array (most recent first)
            JSONArray updatedArray = new JSONArray();
            updatedArray.put(newObject);
            for (int i = 0; i < jsonArray.length(); i++) {
                updatedArray.put(jsonArray.get(i));
            }

            prefs.edit().putString(KEY_SCAN_RECORDS, updatedArray.toString()).apply();
        } catch (JSONException e) {
            Log.e(TAG, "Error saving scan record", e);
        }

        return record;
    }

    public static synchronized JSArray getRecords(Context context) {
        JSArray jsArray = new JSArray();
        SharedPreferences prefs = getPrefs(context);
        String existingJson = prefs.getString(KEY_SCAN_RECORDS, "[]");

        try {
            JSONArray jsonArray = new JSONArray(existingJson);
            for (int i = 0; i < jsonArray.length(); i++) {
                JSONObject obj = jsonArray.getJSONObject(i);
                JSObject jsObj = new JSObject();
                jsObj.put("id", obj.optString("id"));
                jsObj.put("text", obj.optString("text"));
                jsObj.put("blockCount", obj.optInt("blockCount"));
                jsObj.put("timestamp", obj.optString("timestamp"));
                jsArray.put(jsObj);
            }
        } catch (JSONException e) {
            Log.e(TAG, "Error reading scan records", e);
        }

        return jsArray;
    }

    public static synchronized void clearRecords(Context context) {
        getPrefs(context).edit().remove(KEY_SCAN_RECORDS).apply();
    }
}
