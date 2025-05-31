const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();

// Configure CORS for production
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost', // Set FRONTEND_URL in .env
  methods: ['POST', 'PATCH', 'GET'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json());

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
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
    '.m4v': 'video/x-m4v',
  };
  if (!mimeTypes[ext]) {
    throw new Error(`Unsupported video format: ${ext}`);
  }
  return mimeTypes[ext];
}

// Configure Multer for video uploads
const upload = multer({
  dest: uploadsDir,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
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
      cb(new Error(`Only video files are allowed! Received: ${file.mimetype} for file: ${file.originalname}`), false);
    }
  },
});

// Rate limiting for upload endpoint
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit to 10 uploads per IP
  message: 'Too many upload requests, please try again later.',
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
  scopes: ['https://www.googleapis.com/auth/drive.file'],
});
const drive = google.drive({ version: 'v3', auth });

const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || '1G0J0gopla4vDAMiaKzOaMPSQ3Y0nrk0U';

// Validate Google Drive folder at startup
async function validateFolder() {
  try {
    await drive.files.get({ fileId: FOLDER_ID, fields: 'id' });
    console.log(`Google Drive folder ${FOLDER_ID} is accessible.`);
  } catch (error) {
    console.error(`Error accessing Google Drive folder ${FOLDER_ID}:`, error.message);
    process.exit(1);
  }
}
validateFolder();

// Upload endpoint
app.post('/upload-video', uploadLimiter, upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    console.log('File received:', req.file.originalname);
    const originalFileName = req.file.originalname;

    // Extract personName from filename (e.g., PartnershipDeclaration_John_Doe_2025-05-31_1234567890.webm)
    const nameMatch = originalFileName.match(/^PartnershipDeclaration_(.+?)_\d{4}-\d{2}-\d{2}_\d+\.\w+$/);
    const personName = nameMatch ? nameMatch[1] : 'Unknown';

    console.log('Extracted person name:', personName);
    console.log('Final MIME type:', req.file.mimetype);

    const correctMimeType = req.file.mimetype.startsWith('video/')
      ? req.file.mimetype
      : getCorrectMimeType(originalFileName);

    // Use the original filename from the frontend
    const formattedFileName = originalFileName;

    const fileMetadata = {
      name: formattedFileName,
      parents: [FOLDER_ID],
      mimeType: correctMimeType,
    };

    const media = {
      mimeType: correctMimeType,
      body: fs.createReadStream(req.file.path),
    };

    console.log('Uploading to Drive with filename:', formattedFileName);
    console.log('Uploading to Drive with MIME type:', correctMimeType);

    const driveResponse = await drive.files.create({
      resource: fileMetadata,
      media,
      fields: 'id,name,webViewLink,mimeType',
    });

    // Make file public (optional, consider restricted access)
    await drive.permissions.create({
      fileId: driveResponse.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
    });

    // Clean up temporary file
    await fs.unlink(req.file.path).catch(err => console.error('Error deleting temp file:', err));

    console.log('Video uploaded to Drive:', driveResponse.data);

    res.json({
      success: true,
      fileName: driveResponse.data.name,
      driveLink: driveResponse.data.webViewLink,
    });

  } catch (error) {
    console.error('Upload error:', error);
    if (req.file && fs.existsSync(req.file.path)) {
      await fs.unlink(req.file.path).catch(err => console.error('Error deleting temp file on error:', err));
    }
    res.status(500).json({
      error: 'Failed to upload video',
      details: process.env.NODE_ENV === 'production' ? 'Internal server error' : error.message,
    });
  }
});

// Alternative upload endpoint with person name in URL (optional, can be removed if not used)
app.post('/upload-video/:personName', uploadLimiter, upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    const { personName } = req.params;
    if (!personName || personName.trim() === '') {
      return res.status(400).json({ error: 'Person name is required in URL' });
    }

    console.log('File received:', req.file.originalname);
    console.log('Person name from URL:', personName);
    console.log('Final MIME type:', req.file.mimetype);

    const correctMimeType = req.file.mimetype.startsWith('video/')
      ? req.file.mimetype
      : getCorrectMimeType(req.file.originalname);

    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-');
    const fileExtension = path.extname(req.file.originalname);
    const sanitizedPersonName = decodeURIComponent(personName).trim().replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
    const formattedFileName = `${sanitizedPersonName}_${dateStr}_${timeStr}${fileExtension}`;

    const fileMetadata = {
      name: formattedFileName,
      parents: [FOLDER_ID],
      mimeType: correctMimeType,
    };

    const media = {
      mimeType: correctMimeType,
      body: fs.createReadStream(req.file.path),
    };

    console.log('Uploading to Drive with filename:', formattedFileName);
    console.log('Uploading to Drive with MIME type:', correctMimeType);

    const driveResponse = await drive.files.create({
      resource: fileMetadata,
      media,
      fields: 'id,name,webViewLink,mimeType',
    });

    await drive.permissions.create({
      fileId: driveResponse.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
    });

    await fs.unlink(req.file.path).catch(err => console.error('Error deleting temp file:', err));

    console.log('Video uploaded to Drive:', driveResponse.data);

    res.json({
      success: true,
      fileName: driveResponse.data.name,
      driveLink: driveResponse.data.webViewLink,
    });

  } catch (error) {
    console.error('Upload error:', error);
    if (req.file && fs.existsSync(req.file.path)) {
      await fs.unlink(req.file.path).catch(err => console.error('Error deleting temp file on error:', err));
    }
    res.status(500).json({
      error: 'Failed to upload video',
      details: process.env.NODE_ENV === 'production' ? 'Internal server error' : error.message,
    });
  }
});

// MIME type fix endpoint
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
        mimeType: correctMimeType,
      },
      fields: 'id,name,mimeType,webViewLink',
    });

    console.log('MIME type updated:', updateResponse.data);

    res.json({
      success: true,
      fileName: updateResponse.data.name,
      driveLink: updateResponse.data.webViewLink,
    });

  } catch (error) {
    console.error('MIME type fix error:', error);
    res.status(500).json({
      error: 'Failed to fix MIME type',
      details: process.env.NODE_ENV === 'production' ? 'Internal server error' : error.message,
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