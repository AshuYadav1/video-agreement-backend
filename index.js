const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { promisify } = require('util');

const app = express();
app.use(cors());
app.use(express.json());

// Promisify fs functions for better async handling
const unlinkAsync = promisify(fs.unlink);
const statAsync = promisify(fs.stat);

// Create uploads directory if it doesn't exist
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Function to get correct MIME type based on file extension
function getCorrectMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime',
    '.wmv': 'video/x-ms-wmv',
    '.flv': 'video/x-flv',
    '.m4v': 'video/x-m4v'
  };
  return mimeTypes[ext] || 'video/mp4';
}

// Configure multer with memory storage for smaller files, disk for larger
const upload = multer({
  storage: multer.memoryStorage(), // Store in memory for faster access
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  },
  fileFilter: (req, file, cb) => {
    console.log('Received file mimetype:', file.mimetype);
    console.log('File extension:', path.extname(file.originalname));
    
    const isVideoMime = file.mimetype && file.mimetype.startsWith('video/');
    const isVideoExt = file.originalname.match(/\.(mp4|webm|mkv|avi|mov|wmv|flv|m4v)$/i);
    
    if (isVideoMime || isVideoExt) {
      if (!isVideoMime && isVideoExt) {
        file.mimetype = getCorrectMimeType(file.originalname);
        console.log('Corrected MIME type to:', file.mimetype);
      }
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed! Received: ' + file.mimetype + ' for file: ' + file.originalname), false);
    }
  }
});

// Decode and write Google service account key from base64
const decodedKeyPath = path.join(__dirname, 'temp-google-key.json');
if (!fs.existsSync(decodedKeyPath)) {
  if (!process.env.GOOGLE_KEY_BASE64) {
    console.error('Missing GOOGLE_KEY_BASE64 environment variable.');
    process.exit(1);
  }
  
  fs.writeFileSync(
    decodedKeyPath,
    Buffer.from(process.env.GOOGLE_KEY_BASE64, 'base64').toString('utf8')
  );
}

// Google Drive setup with connection pooling and timeout optimization
const auth = new google.auth.GoogleAuth({
  keyFile: decodedKeyPath,
  scopes: ['https://www.googleapis.com/auth/drive.file']
});

const drive = google.drive({ 
  version: 'v3', 
  auth,
  timeout: 120000, // 2 minute timeout
  retry: true,
  retryConfig: {
    retry: 3,
    retryDelay: 1000,
    onRetryAttempt: (err) => {
      console.log(`Retry attempt: ${err.config['axios-retry'].currentRetryAttempt}`);
    }
  }
});

const FOLDER_ID = '1VuEY77a5T1AIN2594fTk7NEOlky_mOnp';

// Helper function to create formatted filename
function createFormattedFileName(personName, originalName) {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-');
  const fileExtension = path.extname(originalName);
  const sanitizedPersonName = personName.trim().replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
  return `${sanitizedPersonName}_${dateStr}_${timeStr}${fileExtension}`;
}

// Optimized upload function with parallel operations
async function uploadToGoogleDrive(fileBuffer, fileName, mimeType, makePublic = true) {
  const uploadStartTime = Date.now();
  
  const fileMetadata = {
    name: fileName,
    parents: [FOLDER_ID],
    mimeType: mimeType
  };

  const media = {
    mimeType: mimeType,
    body: require('stream').Readable.from(fileBuffer) // Convert buffer to stream
  };

  console.log(`Starting Drive upload for ${fileName} (${(fileBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

  try {
    // Upload file and set permissions in parallel if making public
    const uploadPromise = drive.files.create({
      resource: fileMetadata,
      media,
      fields: 'id,name,webViewLink,mimeType,size',
      uploadType: 'multipart' // Use multipart upload for better performance
    });

    const driveResponse = await uploadPromise;
    console.log(`Drive upload completed in ${Date.now() - uploadStartTime}ms`);

    // Set permissions in parallel if needed
    if (makePublic) {
      const permissionPromise = drive.permissions.create({
        fileId: driveResponse.data.id,
        requestBody: {
          role: 'reader',
          type: 'anyone'
        }
      }).catch(err => {
        console.warn('Failed to set public permissions:', err.message);
        // Don't fail the entire upload if permission setting fails
      });

      // Don't wait for permission setting to complete
      permissionPromise.then(() => {
        console.log('Permissions set successfully');
      });
    }

    return driveResponse.data;
  } catch (error) {
    console.error('Drive upload error:', error);
    throw error;
  }
}

// Optimized upload endpoint
app.post('/upload-video', upload.single('video'), async (req, res) => {
  const requestStartTime = Date.now();
  
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    const { personName } = req.body;
    if (!personName || personName.trim() === '') {
      return res.status(400).json({ error: 'Person name is required' });
    }

    console.log(`Processing upload: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(2)} MB)`);

    // Get correct MIME type
    const correctMimeType = req.file.mimetype.startsWith('video/') 
      ? req.file.mimetype 
      : getCorrectMimeType(req.file.originalname);

    // Create formatted filename
    const formattedFileName = createFormattedFileName(personName, req.file.originalname);

    // Upload to Google Drive (using buffer from memory storage)
    const driveResponse = await uploadToGoogleDrive(
      req.file.buffer,
      formattedFileName,
      correctMimeType,
      true // Make public
    );

    const totalTime = Date.now() - requestStartTime;
    console.log(`Total request completed in ${totalTime}ms`);

    const sanitizedPersonName = personName.trim().replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
    const dateStr = new Date().toISOString().split('T')[0];

    res.json({
      success: true,
      message: 'Video uploaded successfully!',
      fileId: driveResponse.id,
      fileName: driveResponse.name,
      driveLink: driveResponse.webViewLink,
      mimeType: driveResponse.mimeType,
      fileSize: driveResponse.size,
      personName: sanitizedPersonName,
      uploadDate: dateStr,
      uploadTimeMs: totalTime
    });

  } catch (error) {
    console.error('Upload error:', error);
    
    res.status(500).json({
      error: 'Failed to upload video',
      details: error.message,
      uploadTimeMs: Date.now() - requestStartTime
    });
  }
});

// Alternative upload endpoint with person name in URL (optimized)
app.post('/upload-video/:personName', upload.single('video'), async (req, res) => {
  const requestStartTime = Date.now();
  
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    const { personName } = req.params;
    if (!personName || personName.trim() === '') {
      return res.status(400).json({ error: 'Person name is required in URL' });
    }

    console.log(`Processing upload: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(2)} MB)`);

    const correctMimeType = req.file.mimetype.startsWith('video/') 
      ? req.file.mimetype 
      : getCorrectMimeType(req.file.originalname);

    const decodedPersonName = decodeURIComponent(personName);
    const formattedFileName = createFormattedFileName(decodedPersonName, req.file.originalname);

    const driveResponse = await uploadToGoogleDrive(
      req.file.buffer,
      formattedFileName,
      correctMimeType,
      true
    );

    const totalTime = Date.now() - requestStartTime;
    console.log(`Total request completed in ${totalTime}ms`);

    const sanitizedPersonName = decodedPersonName.trim().replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
    const dateStr = new Date().toISOString().split('T')[0];

    res.json({
      success: true,
      message: 'Video uploaded successfully!',
      fileId: driveResponse.id,
      fileName: driveResponse.name,
      driveLink: driveResponse.webViewLink,
      mimeType: driveResponse.mimeType,
      fileSize: driveResponse.size,
      personName: sanitizedPersonName,
      uploadDate: dateStr,
      uploadTimeMs: totalTime
    });

  } catch (error) {
    console.error('Upload error:', error);
    
    res.status(500).json({
      error: 'Failed to upload video',
      details: error.message,
      uploadTimeMs: Date.now() - requestStartTime
    });
  }
});

// Chunked upload for very large files (alternative approach)
app.post('/upload-video-chunked', upload.single('video'), async (req, res) => {
  const requestStartTime = Date.now();
  
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    const { personName } = req.body;
    if (!personName || personName.trim() === '') {
      return res.status(400).json({ error: 'Person name is required' });
    }

    // For very large files, use resumable upload
    if (req.file.size > 50 * 1024 * 1024) { // 50MB threshold
      console.log('Using resumable upload for large file');
      
      // Implementation would use Google Drive's resumable upload
      // This is more complex but handles large files better
      return res.status(501).json({ 
        error: 'Resumable upload not implemented yet',
        suggestion: 'Use regular upload endpoint for files under 50MB'
      });
    }

    // Use regular optimized upload for smaller files
    const correctMimeType = req.file.mimetype.startsWith('video/') 
      ? req.file.mimetype 
      : getCorrectMimeType(req.file.originalname);

    const formattedFileName = createFormattedFileName(personName, req.file.originalname);

    const driveResponse = await uploadToGoogleDrive(
      req.file.buffer,
      formattedFileName,
      correctMimeType,
      true
    );

    const totalTime = Date.now() - requestStartTime;
    console.log(`Chunked upload completed in ${totalTime}ms`);

    res.json({
      success: true,
      message: 'Video uploaded successfully!',
      fileId: driveResponse.id,
      fileName: driveResponse.name,
      driveLink: driveResponse.webViewLink,
      uploadTimeMs: totalTime
    });

  } catch (error) {
    console.error('Chunked upload error:', error);
    res.status(500).json({
      error: 'Failed to upload video',
      details: error.message
    });
  }
});

// Fix existing file MIME type endpoint (unchanged)
app.patch('/fix-video-mime/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const { fileName } = req.body;

    if (!fileName) {
      return res.status(400).json({ error: 'fileName is required in request body' });
    }

    const correctMimeType = getCorrectMimeType(fileName);

    console.log(`Fixing MIME type for file ${fileId} to ${correctMimeType}`);

    const updateResponse = await drive.files.update({
      fileId: fileId,
      resource: {
        mimeType: correctMimeType
      },
      fields: 'id,name,mimeType,webViewLink'
    });

    console.log('MIME type updated:', updateResponse.data);

    res.json({
      success: true,
      message: 'MIME type updated successfully!',
      fileId: updateResponse.data.id,
      fileName: updateResponse.data.name,
      mimeType: updateResponse.data.mimeType,
      driveLink: updateResponse.data.webViewLink
    });

  } catch (error) {
    console.error('Error updating MIME type:', error);

    res.status(500).json({
      error: 'Failed to update MIME type',
      details: error.message
    });
  }
});

// Health check with performance info
app.get('/health', (req, res) => {
  res.json({ 
    status: 'Server is running!',
    optimizations: [
      'Memory storage for faster file access',
      'Parallel permission setting',
      'Optimized Google Drive API configuration',
      'Better error handling and logging'
    ]
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Optimized server running on port ${PORT}`);
});