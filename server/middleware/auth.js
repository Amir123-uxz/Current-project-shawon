const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Verify JWT token
const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ message: 'Access token required' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId).select('-password');
    
    if (!user) {
      return res.status(401).json({ message: 'Invalid token - user not found' });
    }

    if (user.isBlocked) {
      return res.status(403).json({ 
        message: 'Account is blocked', 
        reason: user.blockedReason 
      });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token expired' });
    } else if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: 'Invalid token' });
    }
    
    console.error('Auth middleware error:', error);
    return res.status(500).json({ message: 'Authentication error' });
  }
};

// Check if user is admin
const requireAdmin = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    next();
  } catch (error) {
    console.error('Admin middleware error:', error);
    return res.status(500).json({ message: 'Authorization error' });
  }
};

// Optional authentication (for public endpoints that can benefit from user context)
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.userId).select('-password');
      
      if (user && !user.isBlocked) {
        req.user = user;
      }
    }

    next();
  } catch (error) {
    // Continue without user context if token is invalid
    next();
  }
};

// Check if user has sufficient chips
const checkChips = (minAmount) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    if (req.user.chips < minAmount) {
      return res.status(400).json({ 
        message: 'Insufficient chips',
        required: minAmount,
        current: req.user.chips
      });
    }

    next();
  };
};

// Rate limiting for sensitive operations
const rateLimitByUser = (windowMs = 15 * 60 * 1000, maxRequests = 5) => {
  const userRequests = new Map();

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const userId = req.user._id.toString();
    const now = Date.now();
    
    if (!userRequests.has(userId)) {
      userRequests.set(userId, []);
    }

    const requests = userRequests.get(userId);
    
    // Remove old requests outside the window
    const validRequests = requests.filter(time => now - time < windowMs);
    
    if (validRequests.length >= maxRequests) {
      return res.status(429).json({ 
        message: 'Too many requests. Please try again later.',
        retryAfter: Math.ceil(windowMs / 1000)
      });
    }

    validRequests.push(now);
    userRequests.set(userId, validRequests);
    
    next();
  };
};

// Validate user is not in an active game (for certain operations)
const requireNotInGame = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    if (req.user.currentGameId) {
      return res.status(400).json({ 
        message: 'Cannot perform this action while in an active game',
        gameId: req.user.currentGameId
      });
    }

    next();
  } catch (error) {
    console.error('Game check middleware error:', error);
    return res.status(500).json({ message: 'Game validation error' });
  }
};

// Log user activity
const logActivity = (action) => {
  return (req, res, next) => {
    if (req.user) {
      console.log(`User ${req.user.username} (${req.user._id}) performed: ${action}`);
      
      // Update last seen
      User.findByIdAndUpdate(req.user._id, { 
        lastSeen: new Date() 
      }).catch(err => console.error('Failed to update last seen:', err));
    }
    
    next();
  };
};

module.exports = {
  authenticateToken,
  requireAdmin,
  optionalAuth,
  checkChips,
  rateLimitByUser,
  requireNotInGame,
  logActivity
};