const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

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
  return mimeTypes[ext] || 'video/mp4'; // Default to mp4 if unknown
}

// Configure multer for video uploads
const upload = multer({
  dest: 'uploads/',
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  },
  fileFilter: (req, file, cb) => {
    console.log('Received file mimetype:', file.mimetype);
    console.log('File extension:', path.extname(file.originalname));
    
    // Check if it's a video by MIME type OR file extension
    const isVideoMime = file.mimetype && file.mimetype.startsWith('video/');
    const isVideoExt = file.originalname.match(/\.(mp4|webm|mkv|avi|mov|wmv|flv|m4v)$/i);
    
    if (isVideoMime || isVideoExt) {
      // Correct the MIME type if it's wrong
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

// Google Drive setup
const auth = new google.auth.GoogleAuth({
  keyFile: decodedKeyPath,
  scopes: ['https://www.googleapis.com/auth/drive.file']
});
const drive = google.drive({ version: 'v3', auth });

// Your shared Google Drive folder ID
const FOLDER_ID = '1VuEY77a5T1AIN2594fTk7NEOlky_mOnp';

// Upload endpoint
app.post('/upload-video', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    // Get person name from request body
    const { personName } = req.body;
    if (!personName || personName.trim() === '') {
      return res.status(400).json({ error: 'Person name is required' });
    }

    console.log('File received:', req.file.originalname);
    console.log('Person name:', personName);
    console.log('Final MIME type:', req.file.mimetype);

    // Ensure we have the correct MIME type for Drive upload
    const correctMimeType = req.file.mimetype.startsWith('video/') 
      ? req.file.mimetype 
      : getCorrectMimeType(req.file.originalname);

    // Create formatted filename: PersonName_YYYY-MM-DD_HH-MM-SS.extension
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-'); // HH-MM-SS
    const fileExtension = path.extname(req.file.originalname);
    const sanitizedPersonName = personName.trim().replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
    const formattedFileName = `${sanitizedPersonName}_${dateStr}_${timeStr}${fileExtension}`;

    const fileMetadata = {
      name: formattedFileName,
      parents: [FOLDER_ID]
    };

    const media = {
      mimeType: correctMimeType,
      body: fs.createReadStream(req.file.path)
    };

    // Also set the MIME type in the file metadata to ensure Drive recognizes it correctly
    fileMetadata.mimeType = correctMimeType;

    console.log('Uploading to Drive with filename:', formattedFileName);
    console.log('Uploading to Drive with MIME type:', correctMimeType);

    const driveResponse = await drive.files.create({
      resource: fileMetadata,
      media,
      fields: 'id,name,webViewLink,mimeType'
    });

    // Optional: make file public
    await drive.permissions.create({
      fileId: driveResponse.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone'
      }
    });

    // Clean up temporary file
    fs.unlink(req.file.path, err => {
      if (err) console.error('Error deleting temp file:', err);
    });

    console.log('Video uploaded to Drive:', driveResponse.data);

    res.json({
      success: true,
      message: 'Video uploaded successfully!',
      fileId: driveResponse.data.id,
      fileName: driveResponse.data.name,
      driveLink: driveResponse.data.webViewLink,
      mimeType: driveResponse.data.mimeType,
      personName: sanitizedPersonName,
      uploadDate: dateStr
    });

  } catch (error) {
    console.error('Upload error:', error);

    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlink(req.file.path, err => {
        if (err) console.error('Error deleting temp file on error:', err);
      });
    }

    res.status(500).json({
      error: 'Failed to upload video',
      details: error.message
    });
  }
});

// Alternative upload endpoint with person name in URL
app.post('/upload-video/:personName', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    // Get person name from URL parameter
    const { personName } = req.params;
    if (!personName || personName.trim() === '') {
      return res.status(400).json({ error: 'Person name is required in URL' });
    }

    console.log('File received:', req.file.originalname);
    console.log('Person name from URL:', personName);
    console.log('Final MIME type:', req.file.mimetype);

    // Ensure we have the correct MIME type for Drive upload
    const correctMimeType = req.file.mimetype.startsWith('video/') 
      ? req.file.mimetype 
      : getCorrectMimeType(req.file.originalname);

    // Create formatted filename: PersonName_YYYY-MM-DD_HH-MM-SS.extension
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-'); // HH-MM-SS
    const fileExtension = path.extname(req.file.originalname);
    const sanitizedPersonName = decodeURIComponent(personName).trim().replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
    const formattedFileName = `${sanitizedPersonName}_${dateStr}_${timeStr}${fileExtension}`;

    const fileMetadata = {
      name: formattedFileName,
      parents: [FOLDER_ID],
      mimeType: correctMimeType
    };

    const media = {
      mimeType: correctMimeType,
      body: fs.createReadStream(req.file.path)
    };

    console.log('Uploading to Drive with filename:', formattedFileName);
    console.log('Uploading to Drive with MIME type:', correctMimeType);

    const driveResponse = await drive.files.create({
      resource: fileMetadata,
      media,
      fields: 'id,name,webViewLink,mimeType'
    });

    // Optional: make file public
    await drive.permissions.create({
      fileId: driveResponse.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone'
      }
    });

    // Clean up temporary file
    fs.unlink(req.file.path, err => {
      if (err) console.error('Error deleting temp file:', err);
    });

    console.log('Video uploaded to Drive:', driveResponse.data);

    res.json({
      success: true,
      message: 'Video uploaded successfully!',
      fileId: driveResponse.data.id,
      fileName: driveResponse.data.name,
      driveLink: driveResponse.data.webViewLink,
      mimeType: driveResponse.data.mimeType,
      personName: sanitizedPersonName,
      uploadDate: dateStr
    });

  } catch (error) {
    console.error('Upload error:', error);

    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlink(req.file.path, err => {
        if (err) console.error('Error deleting temp file on error:', err);
      });
    }

    res.status(500).json({
      error: 'Failed to upload video',
      details: error.message
    });
  }
});

// Fix existing file MIME type endpoint
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


// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'Server is running!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});