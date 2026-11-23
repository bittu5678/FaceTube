<?php
/**
 * FaceTube - Image Upload API
 * POST /api/uploads/image.php
 */

require_once __DIR__ . '/../response.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}

$rawPostPurpose = isset($_POST['purpose']) ? trim((string)$_POST['purpose']) : '';
$rawGetPurpose = isset($_GET['purpose']) ? trim((string)$_GET['purpose']) : '';
$rawReqPurpose = isset($_REQUEST['purpose']) ? trim((string)$_REQUEST['purpose']) : '';
$purpose = strtolower(
    $rawPostPurpose !== ''
        ? $rawPostPurpose
        : ($rawGetPurpose !== ''
            ? $rawGetPurpose
            : ($rawReqPurpose !== '' ? $rawReqPurpose : 'default'))
);
$isChannelLogo = ($purpose === 'channel_logo');

if ($isChannelLogo) {
    require_once __DIR__ . '/../config/database.php';
    $pdo = getDatabaseConnection();
    $authUser = getAuthUser($pdo);
    if (!$authUser) {
        jsonResponse([
            'success' => false,
            'error' => 'Authentication required for channel logo upload.'
        ], 401);
    }
}

$subfolder = $isChannelLogo ? 'logos' : 'images';

// Support direct file upload or multipart
$uploadDir = ensureMediaStorageDir($subfolder);
if (!$uploadDir) {
    jsonResponse([
        'success' => false,
        'error' => 'Failed to initialize image upload storage directory on Hostinger.'
    ], 500);
}

if (!empty($_FILES['image']) && $_FILES['image']['error'] === UPLOAD_ERR_OK) {
    $tmpName = $_FILES['image']['tmp_name'];
    $origName = basename($_FILES['image']['name']);
    $ext = strtolower(pathinfo($origName, PATHINFO_EXTENSION));
    $allowedExts = ['jpg', 'jpeg', 'png', 'webp'];
    if (!in_array($ext, $allowedExts, true)) {
        jsonResponse([
            'success' => false,
            'error' => 'Unsupported image format ".' . htmlspecialchars($ext) . '". Supported formats are JPG, JPEG, PNG, WEBP.'
        ], 400);
    }

    $maxBytes = $isChannelLogo ? (10 * 1024 * 1024) : (25 * 1024 * 1024);
    if ($_FILES['image']['size'] <= 0) {
        jsonResponse([
            'success' => false,
            'error' => 'Uploaded image file is empty.'
        ], 400);
    }
    if ($_FILES['image']['size'] > $maxBytes) {
        $maxLabel = $isChannelLogo ? '10MB' : '25MB';
        jsonResponse([
            'success' => false,
            'error' => "Image file size exceeds maximum permitted limit ({$maxLabel})."
        ], 400);
    }

    $imageInfo = @getimagesize($tmpName);
    if ($isChannelLogo) {
        if (!$imageInfo || empty($imageInfo[0]) || empty($imageInfo[1])) {
            jsonResponse([
                'success' => false,
                'error' => 'Invalid channel logo image file. Please upload a valid JPG, PNG, or WEBP image.'
            ], 400);
        }
        $allowedTypes = [IMAGETYPE_JPEG, IMAGETYPE_PNG, IMAGETYPE_WEBP];
        if (!in_array((int)$imageInfo[2], $allowedTypes, true)) {
            jsonResponse([
                'success' => false,
                'error' => 'Invalid image content type. Only JPG, PNG, and WEBP images are permitted.'
            ], 400);
        }
        if (class_exists('finfo')) {
            $finfo = new finfo(FILEINFO_MIME_TYPE);
            $detectedMime = $finfo->file($tmpName);
            if (!in_array($detectedMime, ['image/jpeg', 'image/png', 'image/webp'], true)) {
                jsonResponse([
                    'success' => false,
                    'error' => 'Image MIME verification failed.'
                ], 400);
            }
        }
        $logoWidth = (int)$imageInfo[0];
        $logoHeight = (int)$imageInfo[1];
        if ($logoWidth > 4096 || $logoHeight > 4096) {
            jsonResponse([
                'success' => false,
                'error' => "Channel logo dimensions exceed maximum allowed size (4096x4096). Current dimensions: {$logoWidth}x{$logoHeight}."
            ], 400);
        }
        $logoRatio = $logoWidth / $logoHeight;
        if (abs($logoRatio - 1.0) > 0.08) {
            jsonResponse([
                'success' => false,
                'error' => "Channel logo must be a square (1:1) image (e.g. 512x512). Current dimensions: {$logoWidth}x{$logoHeight}."
            ], 400);
        }
    } else {
        // Enforce 9:16 aspect ratio for standard image uploads
        if ($imageInfo) {
            $width = $imageInfo[0];
            $height = $imageInfo[1];
            if ($width > 0 && $height > 0) {
                $ratio = $width / $height;
                $targetRatio = 9 / 16; // 0.5625
                if (abs($ratio - $targetRatio) > 0.08) {
                    jsonResponse([
                        'success' => false,
                        'error' => "Image must strictly be in 9:16 vertical aspect ratio (e.g. 1080x1920). Current dimensions: {$width}x{$height}."
                    ], 400);
                }
            }
        }
    }

    $uniqueId = time() . '_' . substr(md5(random_bytes(6)), 0, 6);
    $counter = 0;
    $prefix = $isChannelLogo ? 'logo_' : 'img_';
    $candidateName = $prefix . $uniqueId . '.' . ($ext ?: 'jpg');
    while (file_exists($uploadDir . $candidateName)) {
        $counter++;
        $candidateName = $prefix . $uniqueId . '_' . $counter . '.' . ($ext ?: 'jpg');
    }
    $fileName = $candidateName;
    $target = $uploadDir . $fileName;

    if (@move_uploaded_file($tmpName, $target)) {
        // Sync to secondary storage directories (e.g. root uploads/)
        $allDirs = getMediaStorageDirectories($subfolder);
        foreach ($allDirs as $otherDir) {
            if ($otherDir !== $uploadDir && is_dir($otherDir) && is_writable($otherDir)) {
                @copy($target, $otherDir . $fileName);
            }
        }

        $publicUrl = toAbsoluteMediaUrl('/uploads/' . $subfolder . '/' . $fileName, $subfolder);

        jsonResponse([
            'success' => true,
            'url' => $publicUrl,
            'fileName' => $fileName,
            'format' => $ext,
            'fileSize' => round($_FILES['image']['size'] / (1024 * 1024), 2) . ' MB'
        ], 201);
    } else {
        jsonResponse([
            'success' => false,
            'error' => 'Failed to write uploaded image to server storage.'
        ], 500);
    }
}

jsonResponse([
    'success' => false,
    'error' => 'No image file uploaded. Field "image" is required (JPG, JPEG, PNG, or WEBP).'
], 400);
