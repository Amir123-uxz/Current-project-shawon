const express = require('express');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const { authenticateToken, rateLimitByUser } = require('../middleware/auth');

const router = express.Router();

// Generate JWT token
const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE || '7d'
  });
};

// Register new user
router.post('/register', [
  body('username')
    .isLength({ min: 3, max: 20 })
    .withMessage('Username must be between 3 and 20 characters')
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('Username can only contain letters, numbers, and underscores'),
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email'),
  body('password')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters long'),
  body('city')
    .optional()
    .isLength({ max: 50 })
    .withMessage('City name too long'),
  body('country')
    .optional()
    .isLength({ max: 50 })
    .withMessage('Country name too long')
], async (req, res) => {
  try {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { username, email, password, city = '', country = '' } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [{ email }, { username }]
    });

    if (existingUser) {
      return res.status(400).json({
        message: existingUser.email === email 
          ? 'Email already registered' 
          : 'Username already taken'
      });
    }

    // Create new user (password will be hashed by pre-save middleware)
    const user = new User({
      username,
      email,
      password,
      city,
      country,
      chips: 0 // No demo balance as requested
    });

    await user.save();

    // Generate token
    const token = generateToken(user._id);

    // Remove password from response
    const userResponse = user.toJSON();

    res.status(201).json({
      message: 'User registered successfully',
      token,
      user: userResponse
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ message: 'Registration failed' });
  }
});

// Login user
router.post('/login', [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email'),
  body('password')
    .notEmpty()
    .withMessage('Password is required')
], async (req, res) => {
  try {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { email, password } = req.body;

    // Find user by email
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    // Check if account is blocked
    if (user.isBlocked) {
      return res.status(403).json({
        message: 'Account is blocked',
        reason: user.blockedReason
      });
    }

    // Verify password
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    // Update user's online status and last seen
    await User.findByIdAndUpdate(user._id, {
      isOnline: true,
      lastSeen: new Date()
    });

    // Generate token
    const token = generateToken(user._id);

    // Remove password from response
    const userResponse = user.toJSON();

    res.json({
      message: 'Login successful',
      token,
      user: userResponse
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Login failed' });
  }
});

// Logout user
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    // Update user's online status
    await User.findByIdAndUpdate(req.user._id, {
      isOnline: false,
      lastSeen: new Date(),
      socketId: null
    });

    res.json({ message: 'Logout successful' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ message: 'Logout failed' });
  }
});

// Get current user profile
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .populate('friends', 'username email avatar isOnline')
      .populate('friendRequests.from', 'username email avatar');

    const stats = user.getStats();

    res.json({
      user: user.toJSON(),
      stats
    });
  } catch (error) {
    console.error('Profile fetch error:', error);
    res.status(500).json({ message: 'Failed to fetch profile' });
  }
});

// Update user profile
router.put('/profile', authenticateToken, [
  body('username')
    .optional()
    .isLength({ min: 3, max: 20 })
    .withMessage('Username must be between 3 and 20 characters')
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('Username can only contain letters, numbers, and underscores'),
  body('city')
    .optional()
    .isLength({ max: 50 })
    .withMessage('City name too long'),
  body('country')
    .optional()
    .isLength({ max: 50 })
    .withMessage('Country name too long'),
  body('avatar')
    .optional()
    .isURL()
    .withMessage('Avatar must be a valid URL')
], async (req, res) => {
  try {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { username, city, country, avatar } = req.body;
    const updateData = {};

    // Check if username is being changed and is available
    if (username && username !== req.user.username) {
      const existingUser = await User.findOne({ username });
      if (existingUser) {
        return res.status(400).json({ message: 'Username already taken' });
      }
      updateData.username = username;
    }

    if (city !== undefined) updateData.city = city;
    if (country !== undefined) updateData.country = country;
    if (avatar !== undefined) updateData.avatar = avatar;

    const updatedUser = await User.findByIdAndUpdate(
      req.user._id,
      updateData,
      { new: true }
    );

    res.json({
      message: 'Profile updated successfully',
      user: updatedUser.toJSON()
    });

  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({ message: 'Failed to update profile' });
  }
});

// Change password
router.put('/change-password', authenticateToken, [
  body('currentPassword')
    .notEmpty()
    .withMessage('Current password is required'),
  body('newPassword')
    .isLength({ min: 6 })
    .withMessage('New password must be at least 6 characters long')
], rateLimitByUser(15 * 60 * 1000, 3), async (req, res) => {
  try {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { currentPassword, newPassword } = req.body;

    // Verify current password
    const user = await User.findById(req.user._id);
    const isCurrentPasswordValid = await user.comparePassword(currentPassword);
    
    if (!isCurrentPasswordValid) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }

    // Update password (will be hashed by pre-save middleware)
    user.password = newPassword;
    await user.save();

    res.json({ message: 'Password changed successfully' });

  } catch (error) {
    console.error('Password change error:', error);
    res.status(500).json({ message: 'Failed to change password' });
  }
});

// Verify token (for client-side token validation)
router.get('/verify', authenticateToken, (req, res) => {
  res.json({
    valid: true,
    user: req.user.toJSON()
  });
});

// Get user's friends list
router.get('/friends', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .populate('friends', 'username email avatar isOnline lastSeen city country');

    res.json({
      friends: user.friends,
      count: user.friends.length
    });
  } catch (error) {
    console.error('Friends fetch error:', error);
    res.status(500).json({ message: 'Failed to fetch friends' });
  }
});

// Send friend request
router.post('/friend-request', authenticateToken, [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { email } = req.body;

    // Can't send friend request to yourself
    if (email === req.user.email) {
      return res.status(400).json({ message: 'Cannot send friend request to yourself' });
    }

    // Find target user
    const targetUser = await User.findOne({ email });
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check if already friends
    if (req.user.friends.includes(targetUser._id)) {
      return res.status(400).json({ message: 'Already friends with this user' });
    }

    // Check if friend request already sent
    const existingRequest = targetUser.friendRequests.find(
      request => request.from.toString() === req.user._id.toString()
    );

    if (existingRequest) {
      return res.status(400).json({ message: 'Friend request already sent' });
    }

    // Add friend request
    targetUser.friendRequests.push({
      from: req.user._id,
      createdAt: new Date()
    });

    await targetUser.save();

    res.json({ message: 'Friend request sent successfully' });

  } catch (error) {
    console.error('Friend request error:', error);
    res.status(500).json({ message: 'Failed to send friend request' });
  }
});

// Accept/reject friend request
router.post('/friend-request/:action', authenticateToken, [
  body('requestId')
    .isMongoId()
    .withMessage('Invalid request ID')
], async (req, res) => {
  try {
    const { action } = req.params; // 'accept' or 'reject'
    const { requestId } = req.body;

    if (!['accept', 'reject'].includes(action)) {
      return res.status(400).json({ message: 'Invalid action' });
    }

    const user = await User.findById(req.user._id);
    const requestIndex = user.friendRequests.findIndex(
      request => request.from.toString() === requestId
    );

    if (requestIndex === -1) {
      return res.status(404).json({ message: 'Friend request not found' });
    }

    const request = user.friendRequests[requestIndex];

    if (action === 'accept') {
      // Add to friends list for both users
      user.friends.push(request.from);
      await user.save();

      const requester = await User.findById(request.from);
      requester.friends.push(user._id);
      await requester.save();
    }

    // Remove the friend request
    user.friendRequests.splice(requestIndex, 1);
    await user.save();

    res.json({
      message: `Friend request ${action}ed successfully`
    });

  } catch (error) {
    console.error('Friend request action error:', error);
    res.status(500).json({ message: 'Failed to process friend request' });
  }
});

module.exports = router;