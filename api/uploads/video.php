<?php
/**
 * FaceTube - Production Video Upload API
 * POST /api/uploads/video.php
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed. Use POST to upload video files.'], 405);
}

$pdo = getDatabaseConnection();

// 1. Strict session authentication check
try {
    $authUser = getAuthUser($pdo, true);
} catch (Throwable $authErr) {
    error_log('[uploads/video.php] Auth DB error: ' . $authErr->getMessage());
    $isConnErr = function_exists('isDatabaseConnectionUnavailableError')
        && isDatabaseConnectionUnavailableError($authErr);
    jsonResponse([
        'success' => false,
        'error' => $isConnErr
            ? 'Database connection unavailable during authentication.'
            : 'Authentication service error during video upload.',
    ], $isConnErr ? 503 : 500);
}

if (!$authUser) {
    jsonResponse([
        'success' => false,
        'error' => 'Authentication required. Please log in before uploading a video file.',
    ], 401);
}

$uploaderUserId = trim((string)($authUser['user_id'] ?? ''));
$optionalVideoId = trim((string)($_POST['videoId'] ?? ($_POST['video_id'] ?? '')));
$optionalOrderId = trim((string)($_POST['orderId'] ?? ($_POST['order_id'] ?? '')));

// 2. Validate optional orderId / videoId ownership before saving media
if ($optionalOrderId !== '') {
    try {
        $stmtOrd = $pdo->prepare('SELECT order_id, user_id, video_id FROM payment_orders WHERE order_id = ? LIMIT 1');
        $stmtOrd->execute([$optionalOrderId]);
        $orderRow = $stmtOrd->fetch(PDO::FETCH_ASSOC);
    } catch (Throwable $ordErr) {
        error_log('[uploads/video.php] Order lookup error: ' . $ordErr->getMessage());
        $isConnErr = function_exists('isDatabaseConnectionUnavailableError')
            && isDatabaseConnectionUnavailableError($ordErr);
        jsonResponse([
            'success' => false,
            'error' => $isConnErr
                ? 'Database connection unavailable verifying linked payment order.'
                : 'Database error verifying linked payment order.',
        ], $isConnErr ? 503 : 500);
    }
    if (!$orderRow) {
        jsonResponse(['success' => false, 'error' => 'Linked payment order was not found.'], 404);
    }
    if (strcasecmp(trim((string)($orderRow['user_id'] ?? '')), $uploaderUserId) !== 0) {
        jsonResponse([
            'success' => false,
            'error' => 'Unauthorized: Cannot link video upload to another user\'s payment order.',
        ], 403);
    }
    $ordVid = trim((string)($orderRow['video_id'] ?? ''));
    if ($optionalVideoId !== '' && $ordVid !== '' && $ordVid !== $optionalVideoId) {
        jsonResponse([
            'success' => false,
            'error' => 'Conflict: Uploaded videoId does not match linked payment order video_id.',
        ], 409);
    }
}

if ($optionalVideoId !== '') {
    try {
        $stmtVid = $pdo->prepare('SELECT id, user_id FROM uploaded_videos WHERE id = ? LIMIT 1');
        $stmtVid->execute([$optionalVideoId]);
        $vidRow = $stmtVid->fetch(PDO::FETCH_ASSOC);
    } catch (Throwable $vidErr) {
        error_log('[uploads/video.php] Video lookup error: ' . $vidErr->getMessage());
        $isConnErr = function_exists('isDatabaseConnectionUnavailableError')
            && isDatabaseConnectionUnavailableError($vidErr);
        jsonResponse([
            'success' => false,
            'error' => $isConnErr
                ? 'Database connection unavailable verifying linked video.'
                : 'Database error verifying linked video.',
        ], $isConnErr ? 503 : 500);
    }
    if ($vidRow && strcasecmp(trim((string)($vidRow['user_id'] ?? '')), $uploaderUserId) !== 0) {
        jsonResponse([
            'success' => false,
            'error' => 'Unauthorized: Cannot attach video upload to another user\'s video record.',
        ], 403);
    }
}

// 3. Fail closed if uploaded_video_assets tracking schema has not been applied
try {
    $stmtTbl = $pdo->query("
        SELECT TABLE_NAME
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'uploaded_video_assets'
        LIMIT 1
    ");
    $tblRows = $stmtTbl ? $stmtTbl->fetchAll(PDO::FETCH_ASSOC) : [];
    if (empty($tblRows)) {
        jsonResponse([
            'success' => false,
            'error' => 'Upload asset ownership tracking schema (uploaded_video_assets) has not been applied yet. Video upload aborted safely.',
        ], 503);
    }
} catch (Throwable $tblErr) {
    error_log('[uploads/video.php] Schema check error: ' . $tblErr->getMessage());
    jsonResponse([
        'success' => false,
        'error' => 'Database error verifying upload asset ownership schema.',
    ], 503);
}

// Ensure destination storage directory exists and is writable in the public web root
$uploadDir = ensureMediaStorageDir('videos');
if (!$uploadDir) {
    jsonResponse([
        'success' => false,
        'error' => 'Failed to initialize video upload storage directory. Please verify write permissions on uploads/videos/ on Hostinger.'
    ], 500);
}

if (empty($_FILES['video'])) {
    jsonResponse([
        'success' => false,
        'error' => 'No video file was sent in the request. Please attach a video file with field name "video".'
    ], 400);
}

$file = $_FILES['video'];

// Handle PHP upload error codes
if ($file['error'] !== UPLOAD_ERR_OK) {
    $uploadErrors = [
        UPLOAD_ERR_INI_SIZE   => 'The uploaded file exceeds the upload_max_filesize directive in php.ini.',
        UPLOAD_ERR_FORM_SIZE  => 'The uploaded file exceeds the MAX_FILE_SIZE directive in the HTML form.',
        UPLOAD_ERR_PARTIAL    => 'The uploaded file was only partially uploaded.',
        UPLOAD_ERR_NO_FILE    => 'No file was uploaded.',
        UPLOAD_ERR_NO_TMP_DIR => 'Missing temporary folder on the server.',
        UPLOAD_ERR_CANT_WRITE => 'Failed to write file to disk.',
        UPLOAD_ERR_EXTENSION  => 'A PHP extension stopped the file upload.',
    ];
    $errMsg = $uploadErrors[$file['error']] ?? 'Unknown error occurred during file upload.';
    jsonResponse(['success' => false, 'error' => $errMsg], 400);
}

$fileSize = $file['size'];
$maxSizeBytes = 250 * 1024 * 1024; // 250 MB
if ($fileSize <= 0) {
    jsonResponse(['success' => false, 'error' => 'The uploaded video file is empty (0 bytes).'], 400);
}
if ($fileSize > $maxSizeBytes) {
    jsonResponse([
        'success' => false,
        'error' => 'Video file size exceeds maximum permitted limit (250MB). Please compress or trim the video.'
    ], 400);
}

// Validate file extension
$origName = basename($file['name']);
$ext = strtolower(pathinfo($origName, PATHINFO_EXTENSION));
$allowedExts = ['mp4', 'webm', 'ogg', 'mov', 'm4v', 'mkv'];

if (!in_array($ext, $allowedExts, true)) {
    jsonResponse([
        'success' => false,
        'error' => 'Unsupported video format "' . htmlspecialchars($ext) . '". Supported formats are MP4, WebM, OGG, MOV, M4V.'
    ], 400);
}

// Validate MIME type using finfo if available
$tmpName = $file['tmp_name'];
$mime = '';
if (function_exists('finfo_open')) {
    $finfo = finfo_open(FILEINFO_MIME_TYPE);
    $mime = finfo_file($finfo, $tmpName);
    finfo_close($finfo);
} elseif (!empty($file['type'])) {
    $mime = $file['type'];
}

$allowedMimes = [
    'video/mp4',
    'video/webm',
    'video/ogg',
    'video/quicktime',
    'video/x-m4v',
    'video/x-matroska',
    'application/octet-stream', // fallback for some browsers
];

if (!empty($mime) && !in_array($mime, $allowedMimes, true)) {
    jsonResponse([
        'success' => false,
        'error' => 'Invalid video MIME type ("' . htmlspecialchars($mime) . '"). Only authentic video files are accepted.'
    ], 400);
}

// Generate unique, non-guessable production filename
$safeBaseName = preg_replace('/[^a-zA-Z0-9_-]/', '_', pathinfo($origName, PATHINFO_FILENAME));
$safeBaseName = substr($safeBaseName, 0, 30);
$uniqueId = time() . '_' . bin2hex(random_bytes(6));
$counter = 0;
$candidateName = 'vid_' . $uniqueId . '.' . $ext;
while (file_exists($uploadDir . $candidateName)) {
    $counter++;
    $candidateName = 'vid_' . $uniqueId . '_' . $counter . '.' . $ext;
}
$fileName = $candidateName;
$target = $uploadDir . $fileName;

if (!@move_uploaded_file($tmpName, $target)) {
    jsonResponse([
        'success' => false,
        'error' => 'Failed to save uploaded video to storage. Please check disk space and file write permissions.'
    ], 500);
}

// Sync to secondary storage directories (e.g. root uploads/) so both docroots stay consistent
$savedFiles = [$target];
$allDirs = getMediaStorageDirectories('videos');
foreach ($allDirs as $otherDir) {
    if ($otherDir !== $uploadDir && is_dir($otherDir) && is_writable($otherDir)) {
        if (@copy($target, $otherDir . $fileName)) {
            $savedFiles[] = $otherDir . $fileName;
        }
    }
}

$relativePath = '/uploads/videos/' . $fileName;
$publicUrl = toAbsoluteMediaUrl($relativePath, 'videos');
$assetId = 'ast_' . round(microtime(true) * 1000) . '_' . bin2hex(random_bytes(6));

try {
    $stmtAsset = $pdo->prepare('
        INSERT INTO uploaded_video_assets
            (id, user_id, file_name, relative_path, public_url, video_id, order_id, size_bytes, format, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
    ');
    $stmtAsset->execute([
        $assetId,
        $uploaderUserId,
        $fileName,
        $relativePath,
        $publicUrl,
        $optionalVideoId !== '' ? $optionalVideoId : null,
        $optionalOrderId !== '' ? $optionalOrderId : null,
        (int)$fileSize,
        $ext,
    ]);
} catch (Throwable $assetErr) {
    foreach ($savedFiles as $sf) {
        @unlink($sf);
    }
    error_log('[uploads/video.php] Failed to persist asset ownership row: ' . $assetErr->getMessage());
    $isConnErr = function_exists('isDatabaseConnectionUnavailableError')
        && isDatabaseConnectionUnavailableError($assetErr);
    jsonResponse([
        'success' => false,
        'error' => $isConnErr
            ? 'Database connection unavailable recording uploaded asset ownership.'
            : 'Database error recording uploaded asset ownership.',
    ], $isConnErr ? 503 : 500);
}

$fileSizeMb = round($fileSize / (1024 * 1024), 2) . ' MB';

jsonResponse([
    'success' => true,
    'assetId' => $assetId,
    'url' => $publicUrl,
    'relativePath' => $relativePath,
    'fileName' => $fileName,
    'format' => $ext,
    'fileSize' => $fileSizeMb,
    'sizeBytes' => $fileSize,
    'uploadedAt' => date('c'),
], 201);
