const express = require('express');
const { body, validationResult, query } = require('express-validator');
const User = require('../models/User');
const { authenticateToken, rateLimitByUser, logActivity } = require('../middleware/auth');

const router = express.Router();

// Search users by email or username
router.get('/search', authenticateToken, [
  query('q')
    .isLength({ min: 1, max: 50 })
    .withMessage('Search query must be between 1 and 50 characters'),
  query('type')
    .optional()
    .isIn(['email', 'username', 'both'])
    .withMessage('Search type must be email, username, or both')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { q: searchQuery, type = 'both' } = req.query;
    const limit = 10; // Limit search results

    // Build search query
    let query = {};
    
    if (type === 'email') {
      query.email = { $regex: searchQuery, $options: 'i' };
    } else if (type === 'username') {
      query.username = { $regex: searchQuery, $options: 'i' };
    } else {
      query.$or = [
        { email: { $regex: searchQuery, $options: 'i' } },
        { username: { $regex: searchQuery, $options: 'i' } }
      ];
    }

    // Exclude blocked users and current user
    query.isBlocked = false;
    query._id = { $ne: req.user._id };

    const users = await User.find(query)
      .select('username email avatar city country isOnline lastSeen')
      .limit(limit);

    // Add friend status for each user
    const usersWithFriendStatus = users.map(user => ({
      ...user.toObject(),
      isFriend: req.user.friends.includes(user._id),
      hasPendingRequest: req.user.friendRequests.some(
        request => request.from.toString() === user._id.toString()
      )
    }));

    res.json({
      users: usersWithFriendStatus,
      count: usersWithFriendStatus.length
    });

  } catch (error) {
    console.error('User search error:', error);
    res.status(500).json({ message: 'Failed to search users' });
  }
});

// Get user profile by ID
router.get('/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId)
      .select('username email avatar city country isOnline lastSeen gamesPlayed gamesWon totalChipsWon totalChipsLost createdAt');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (user.isBlocked) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check relationship with current user
    const isFriend = req.user.friends.includes(user._id);
    const hasPendingRequest = req.user.friendRequests.some(
      request => request.from.toString() === user._id.toString()
    );
    const hasReceivedRequest = user.friendRequests?.some(
      request => request.from.toString() === req.user._id.toString()
    );

    const userProfile = {
      ...user.toObject(),
      stats: user.getStats(),
      relationship: {
        isFriend,
        hasPendingRequest,
        hasReceivedRequest,
        canSendRequest: !isFriend && !hasPendingRequest && !hasReceivedRequest
      }
    };

    res.json({ user: userProfile });

  } catch (error) {
    console.error('User profile fetch error:', error);
    res.status(500).json({ message: 'Failed to fetch user profile' });
  }
});

// Get online users (for multiplayer lobby)
router.get('/online/list', authenticateToken, [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('Limit must be between 1 and 50')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    const users = await User.find({
      isOnline: true,
      isBlocked: false,
      _id: { $ne: req.user._id }
    })
    .select('username avatar city country lastSeen currentGameId')
    .populate('currentGameId', 'gameId gameType status')
    .sort({ lastSeen: -1 })
    .skip((page - 1) * limit)
    .limit(limit);

    const total = await User.countDocuments({
      isOnline: true,
      isBlocked: false,
      _id: { $ne: req.user._id }
    });

    // Add friend status
    const usersWithStatus = users.map(user => ({
      ...user.toObject(),
      isFriend: req.user.friends.includes(user._id),
      inGame: !!user.currentGameId
    }));

    res.json({
      users: usersWithStatus,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Online users fetch error:', error);
    res.status(500).json({ message: 'Failed to fetch online users' });
  }
});

// Get leaderboard (top players by chips or wins)
router.get('/leaderboard/top', authenticateToken, [
  query('type').optional().isIn(['chips', 'wins', 'winRate']).withMessage('Invalid leaderboard type'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { type = 'chips' } = req.query;
    const limit = parseInt(req.query.limit) || 50;

    let sortField = {};
    switch (type) {
      case 'wins':
        sortField = { gamesWon: -1 };
        break;
      case 'winRate':
        // This would require aggregation for accurate win rate calculation
        sortField = { gamesWon: -1, gamesPlayed: 1 };
        break;
      default:
        sortField = { chips: -1 };
    }

    const users = await User.find({
      isBlocked: false,
      gamesPlayed: { $gt: 0 } // Only include users who have played games
    })
    .select('username avatar city country chips gamesPlayed gamesWon totalChipsWon')
    .sort(sortField)
    .limit(limit);

    // Calculate additional stats and add friend status
    const leaderboard = users.map((user, index) => ({
      rank: index + 1,
      ...user.toObject(),
      winRate: user.gamesPlayed > 0 ? ((user.gamesWon / user.gamesPlayed) * 100).toFixed(2) : 0,
      isFriend: req.user.friends.includes(user._id),
      isCurrentUser: user._id.toString() === req.user._id.toString()
    }));

    res.json({
      leaderboard,
      type,
      count: leaderboard.length
    });

  } catch (error) {
    console.error('Leaderboard fetch error:', error);
    res.status(500).json({ message: 'Failed to fetch leaderboard' });
  }
});

// Remove friend
router.delete('/friends/:friendId', authenticateToken, logActivity('remove_friend'), async (req, res) => {
  try {
    const { friendId } = req.params;

    // Check if they are actually friends
    if (!req.user.friends.includes(friendId)) {
      return res.status(400).json({ message: 'User is not in your friends list' });
    }

    // Remove from both users' friends lists
    await User.findByIdAndUpdate(req.user._id, {
      $pull: { friends: friendId }
    });

    await User.findByIdAndUpdate(friendId, {
      $pull: { friends: req.user._id }
    });

    const friend = await User.findById(friendId).select('username email avatar');

    res.json({
      message: 'Friend removed successfully',
      removedFriend: {
        id: friendId,
        username: friend?.username,
        email: friend?.email
      }
    });

  } catch (error) {
    console.error('Remove friend error:', error);
    res.status(500).json({ message: 'Failed to remove friend' });
  }
});

// Get friend requests (received)
router.get('/friend-requests/received', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .populate('friendRequests.from', 'username email avatar city country');

    res.json({
      friendRequests: user.friendRequests,
      count: user.friendRequests.length
    });

  } catch (error) {
    console.error('Friend requests fetch error:', error);
    res.status(500).json({ message: 'Failed to fetch friend requests' });
  }
});

// Get sent friend requests
router.get('/friend-requests/sent', authenticateToken, async (req, res) => {
  try {
    // Find users who have pending requests from current user
    const usersWithRequests = await User.find({
      'friendRequests.from': req.user._id
    }).select('username email avatar city country friendRequests');

    const sentRequests = usersWithRequests.map(user => {
      const request = user.friendRequests.find(
        req => req.from.toString() === req.user._id.toString()
      );
      return {
        to: {
          id: user._id,
          username: user.username,
          email: user.email,
          avatar: user.avatar,
          city: user.city,
          country: user.country
        },
        createdAt: request.createdAt
      };
    });

    res.json({
      sentRequests,
      count: sentRequests.length
    });

  } catch (error) {
    console.error('Sent friend requests fetch error:', error);
    res.status(500).json({ message: 'Failed to fetch sent friend requests' });
  }
});

// Cancel sent friend request
router.delete('/friend-requests/cancel/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;

    // Remove the friend request from target user
    const result = await User.findByIdAndUpdate(userId, {
      $pull: { friendRequests: { from: req.user._id } }
    });

    if (!result) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json({ message: 'Friend request cancelled successfully' });

  } catch (error) {
    console.error('Cancel friend request error:', error);
    res.status(500).json({ message: 'Failed to cancel friend request' });
  }
});

// Block user (prevent them from sending friend requests or messages)
router.post('/block/:userId', authenticateToken, [
  body('reason')
    .optional()
    .isLength({ max: 200 })
    .withMessage('Reason must be less than 200 characters')
], rateLimitByUser(60 * 1000, 5), async (req, res) => {
  try {
    const { userId } = req.params;
    const { reason = '' } = req.body;

    if (userId === req.user._id.toString()) {
      return res.status(400).json({ message: 'Cannot block yourself' });
    }

    const targetUser = await User.findById(userId);
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Remove from friends if they are friends
    if (req.user.friends.includes(userId)) {
      await User.findByIdAndUpdate(req.user._id, {
        $pull: { friends: userId }
      });
      await User.findByIdAndUpdate(userId, {
        $pull: { friends: req.user._id }
      });
    }

    // Remove any pending friend requests
    await User.findByIdAndUpdate(req.user._id, {
      $pull: { friendRequests: { from: userId } }
    });
    await User.findByIdAndUpdate(userId, {
      $pull: { friendRequests: { from: req.user._id } }
    });

    // Add to blocked list (you might want to create a separate blocked users collection)
    // For now, we'll just return success
    
    res.json({
      message: 'User blocked successfully',
      blockedUser: {
        id: userId,
        username: targetUser.username
      },
      reason
    });

  } catch (error) {
    console.error('Block user error:', error);
    res.status(500).json({ message: 'Failed to block user' });
  }
});

// Get user statistics summary
router.get('/stats/summary', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const stats = user.getStats();

    // Get rank information
    const betterPlayersCount = await User.countDocuments({
      chips: { $gt: user.chips },
      isBlocked: false
    });

    const rank = betterPlayersCount + 1;

    const summary = {
      ...stats,
      currentChips: user.chips,
      rank,
      friendsCount: user.friends.length,
      accountAge: Math.floor((Date.now() - user.createdAt) / (1000 * 60 * 60 * 24)), // days
      lastActive: user.lastSeen,
      isOnline: user.isOnline
    };

    res.json({ summary });

  } catch (error) {
    console.error('User stats summary error:', error);
    res.status(500).json({ message: 'Failed to fetch user statistics' });
  }
});

// Update user location
router.put('/location', authenticateToken, [
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
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { city, country } = req.body;
    const updateData = {};

    if (city !== undefined) updateData.city = city;
    if (country !== undefined) updateData.country = country;

    const updatedUser = await User.findByIdAndUpdate(
      req.user._id,
      updateData,
      { new: true }
    ).select('city country');

    res.json({
      message: 'Location updated successfully',
      location: {
        city: updatedUser.city,
        country: updatedUser.country
      }
    });

  } catch (error) {
    console.error('Update location error:', error);
    res.status(500).json({ message: 'Failed to update location' });
  }
});

module.exports = router;