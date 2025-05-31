const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Configure multer for video uploads
const upload = multer({
  dest: 'uploads/', // temporary storage
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  },
 fileFilter: (req, file, cb) => {
  if (file.mimetype.startsWith('video/')) {
    cb(null, true);
  } else {
    cb(new Error('Only video files are allowed! Received: ' + file.mimetype), false);
  }
}

});

// Google Drive setup
const auth = new google.auth.GoogleAuth({
 keyFile: 'D:/Documents/Video-agreement-Backend/evslotbookingapp-52cccd328d7b.json',
  scopes: ['https://www.googleapis.com/auth/drive.file']
});

const drive = google.drive({ version: 'v3', auth });

// Your shared folder ID (get this from Google Drive URL)
const FOLDER_ID = '1G0J0gopla4vDAMiaKzOaMPSQ3Y0nrk0U'; // Update this

// Upload endpoint
app.post('/upload-video', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    console.log('File received:', req.file.originalname);

    // Upload to Google Drive
    const fileMetadata = {
      name: `${Date.now()}_${req.file.originalname}`,
      parents: [FOLDER_ID] // Upload to your shared folder
    };

    const media = {
      mimeType: req.file.mimetype,
      body: fs.createReadStream(req.file.path)
    };

    const driveResponse = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id,name,webViewLink'
    });

    // Clean up temporary file
   fs.unlink(req.file.path, (err) => {
  if (err) console.error('Error deleting temp file:', err);
});

    console.log('Video uploaded to Drive:', driveResponse.data);

    res.json({
      success: true,
      message: 'Video uploaded successfully!',
      fileId: driveResponse.data.id,
      fileName: driveResponse.data.name,
      driveLink: driveResponse.data.webViewLink
    });

  } catch (error) {
    console.error('Upload error:', error);
    
    // Clean up temporary file if it exists
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlink(req.file.path, (err) => {
  if (err) console.error('Error deleting temp file:', err);
});

    }

    res.status(500).json({
      error: 'Failed to upload video',
      details: error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'Server is running!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Create uploads directory if it doesn't exist
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}