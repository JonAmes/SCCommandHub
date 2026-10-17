package com.sccommandhub.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;

import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;

@CapacitorPlugin(
        name = "TextScanner",
        permissions = {
                @Permission(
                        alias = "camera",
                        strings = {Manifest.permission.CAMERA}
                )
        }
)
public class TextScannerPlugin extends Plugin {

    private static final String TAG = "TextScannerPlugin";
    private Uri currentPhotoUri;

    @PluginMethod
    public void scanText(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            requestPermissionForAlias("camera", call, "cameraCallback");
            return;
        }

        startCameraScan(call);
    }

    @PermissionCallback
    private void cameraCallback(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED) {
            startCameraScan(call);
        } else {
            call.reject("Camera permission is required to take a picture for scanning.");
        }
    }

    private void startCameraScan(PluginCall call) {
        try {
            File photoFile = File.createTempFile("scan_photo_", ".jpg", getContext().getCacheDir());
            currentPhotoUri = FileProvider.getUriForFile(
                    getContext(),
                    getContext().getPackageName() + ".fileprovider",
                    photoFile
            );

            Intent takePictureIntent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            takePictureIntent.putExtra(MediaStore.EXTRA_OUTPUT, currentPhotoUri);
            takePictureIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);

            startActivityForResult(call, takePictureIntent, "processCapturedPhoto");
        } catch (IOException e) {
            Log.e(TAG, "Error creating photo temp file", e);
            call.reject("Could not create temporary photo file: " + e.getMessage());
        }
    }

    @ActivityCallback
    private void processCapturedPhoto(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK) {
            call.reject("Camera scan was cancelled.");
            return;
        }

        if (currentPhotoUri == null) {
            call.reject("Captured image URI is missing.");
            return;
        }

        processImageUri(call, currentPhotoUri);
    }

    @PluginMethod
    public void scanFromGallery(PluginCall call) {
        Intent galleryIntent = new Intent(Intent.ACTION_PICK, MediaStore.Images.Media.EXTERNAL_CONTENT_URI);
        startActivityForResult(call, galleryIntent, "processGalleryPhoto");
    }

    @ActivityCallback
    private void processGalleryPhoto(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("Gallery selection was cancelled.");
            return;
        }

        Uri selectedImageUri = result.getData().getData();
        if (selectedImageUri == null) {
            call.reject("Selected image URI is missing.");
            return;
        }

        processImageUri(call, selectedImageUri);
    }

    private void processImageUri(PluginCall call, Uri imageUri) {
        try {
            InputImage image = InputImage.fromFilePath(getContext(), imageUri);
            TextRecognizer recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);

            // Encode image to base64 data URL so web UI can render it like a screenshot
            String dataUrl = null;
            try (InputStream is = getContext().getContentResolver().openInputStream(imageUri)) {
                Bitmap bitmap = BitmapFactory.decodeStream(is);
                if (bitmap != null) {
                    ByteArrayOutputStream baos = new ByteArrayOutputStream();
                    bitmap.compress(Bitmap.CompressFormat.JPEG, 85, baos);
                    byte[] imageBytes = baos.toByteArray();
                    dataUrl = "data:image/jpeg;base64," + Base64.encodeToString(imageBytes, Base64.NO_WRAP);
                }
            } catch (Exception e) {
                Log.w(TAG, "Could not encode image as base64 data URL", e);
            }

            final String finalDataUrl = dataUrl;

            recognizer.process(image)
                    .addOnSuccessListener(visionText -> {
                        String fullText = visionText.getText();
                        int blockCount = visionText.getTextBlocks().size();

                        JSObject record = ScanRecordStore.addRecord(getContext(), fullText, blockCount);

                        JSObject ret = new JSObject();
                        ret.put("text", fullText);
                        ret.put("blockCount", blockCount);
                        ret.put("record", record);
                        if (finalDataUrl != null) {
                            ret.put("imageUrl", finalDataUrl);
                        }

                        JSArray blocksArray = new JSArray();
                        for (Text.TextBlock block : visionText.getTextBlocks()) {
                            JSObject blockObj = new JSObject();
                            blockObj.put("text", block.getText());
                            blocksArray.put(blockObj);
                        }
                        ret.put("blocks", blocksArray);

                        call.resolve(ret);
                    })
                    .addOnFailureListener(e -> {
                        Log.e(TAG, "OCR recognition error", e);
                        call.reject("Failed to recognize text in image: " + e.getMessage());
                    });
        } catch (IOException e) {
            Log.e(TAG, "Error loading image from URI", e);
            call.reject("Failed to load image for scanning: " + e.getMessage());
        }
    }

    @PluginMethod
    public void getRecordedScans(PluginCall call) {
        JSArray records = ScanRecordStore.getRecords(getContext());
        JSObject ret = new JSObject();
        ret.put("scans", records);
        call.resolve(ret);
    }

    @PluginMethod
    public void clearRecordedScans(PluginCall call) {
        ScanRecordStore.clearRecords(getContext());
        JSObject ret = new JSObject();
        ret.put("success", true);
        call.resolve(ret);
    }
}
