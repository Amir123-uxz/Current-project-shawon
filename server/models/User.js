const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    minlength: 3,
    maxlength: 20
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    required: true,
    minlength: 6
  },
  avatar: {
    type: String,
    default: '/images/avatars/default.png'
  },
  chips: {
    type: Number,
    default: 0,
    min: 0
  },
  totalChipsWon: {
    type: Number,
    default: 0
  },
  totalChipsLost: {
    type: Number,
    default: 0
  },
  gamesPlayed: {
    type: Number,
    default: 0
  },
  gamesWon: {
    type: Number,
    default: 0
  },
  isOnline: {
    type: Boolean,
    default: false
  },
  lastSeen: {
    type: Date,
    default: Date.now
  },
  isBlocked: {
    type: Boolean,
    default: false
  },
  blockedReason: {
    type: String,
    default: ''
  },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user'
  },
  friends: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  friendRequests: [{
    from: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  currentGameId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Game',
    default: null
  },
  socketId: {
    type: String,
    default: null
  },
  city: {
    type: String,
    default: ''
  },
  country: {
    type: String,
    default: ''
  },
  verificationCode: {
    type: String,
    default: null
  },
  isEmailVerified: {
    type: Boolean,
    default: false
  },
  passwordResetToken: {
    type: String,
    default: null
  },
  passwordResetExpires: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Index for better query performance
userSchema.index({ email: 1 });
userSchema.index({ username: 1 });
userSchema.index({ isOnline: 1 });
userSchema.index({ chips: -1 });

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  
  try {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Compare password method
userSchema.methods.comparePassword = async function(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Update chips with validation
userSchema.methods.updateChips = function(amount, operation = 'add') {
  if (operation === 'add') {
    this.chips += amount;
  } else if (operation === 'subtract') {
    if (this.chips < amount) {
      throw new Error('Insufficient chips');
    }
    this.chips -= amount;
  } else {
    this.chips = amount;
  }
  return this.save();
};

// Get user statistics
userSchema.methods.getStats = function() {
  return {
    gamesPlayed: this.gamesPlayed,
    gamesWon: this.gamesWon,
    winRate: this.gamesPlayed > 0 ? ((this.gamesWon / this.gamesPlayed) * 100).toFixed(2) : 0,
    totalChipsWon: this.totalChipsWon,
    totalChipsLost: this.totalChipsLost,
    netChips: this.totalChipsWon - this.totalChipsLost
  };
};

// Remove password from JSON output
userSchema.methods.toJSON = function() {
  const user = this.toObject();
  delete user.password;
  delete user.verificationCode;
  delete user.passwordResetToken;
  delete user.passwordResetExpires;
  return user;
};

module.exports = mongoose.model('User', userSchema);