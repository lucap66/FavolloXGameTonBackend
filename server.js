const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase setup
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Middleware
app.use(cors());
app.use(express.json());

// Game state
let currentRound = null;
let gameState = 'waiting'; // waiting, betting, running, crashed

// Utility: Verify Telegram WebApp initData
function verifyTelegramAuth(initData, botToken) {
  // For MVP, simplified verification
  // In production, implement proper HMAC verification
  try {
    const params = new URLSearchParams(initData);
    return params.get('user') ? JSON.parse(params.get('user')) : null;
  } catch (error) {
    return null;
  }
}

// Utility: Generate crash point using provable fairness
function generateCrashPoint(serverSeed, clientSeed, nonce) {
  const hash = crypto.createHash('sha256');
  hash.update(`${serverSeed}:${clientSeed}:${nonce}`);
  const result = hash.digest('hex');
  
  // Convert to crash multiplier (1.00x to ~100x)
  const num = parseInt(result.substring(0, 8), 16);
  const crash = Math.max(1.0, (num / 0xffffffff) * 25 + 1);
  return Math.round(crash * 100) / 100;
}

// Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Auth endpoint - verify Telegram user and create/find in database
app.post('/api/auth', async (req, res) => {
  try {
    const { initData } = req.body;
    
    // Simplified auth for MVP
    const telegramUser = verifyTelegramAuth(initData, process.env.BOT_TOKEN);
    if (!telegramUser) {
      return res.status(401).json({ error: 'Invalid auth data' });
    }

    // Find or create user in database
    let { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('telegram_id', telegramUser.id)
      .single();

    if (error && error.code === 'PGRST116') {
      // User doesn't exist, create new
      const { data: newUser, error: createError } = await supabase
        .from('users')
        .insert([
          {
            telegram_id: telegramUser.id,
            telegram_username: telegramUser.username || '',
            first_name: telegramUser.first_name || '',
            balance_nanotons: 1000000000, // 1 TON testnet starting balance
            last_seen_at: new Date().toISOString()
          }
        ])
        .select()
        .single();

      if (createError) throw createError;
      user = newUser;
    } else if (error) {
      throw error;
    } else {
      // Update last seen
      await supabase
        .from('users')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', user.id);
    }

    res.json({ user, success: true });
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({ error: 'Auth failed' });
  }
});

// Get current user data
app.get('/api/user/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'No auth header' });
    }

    const telegramId = parseInt(authHeader.replace('Bearer ', ''));
    
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('telegram_id', telegramId)
      .single();

    if (error) throw error;
    res.json({ user });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// Get current round status
app.get('/api/rounds/current', async (req, res) => {
  try {
    if (!currentRound) {
      return res.json({ 
        round: null, 
        state: 'waiting',
        nextRoundIn: 5 
      });
    }

    const { data: round, error } = await supabase
      .from('rounds')
      .select('*')
      .eq('id', currentRound.id)
      .single();

    if (error) throw error;

    res.json({ 
      round, 
      state: gameState,
      multiplier: currentRound.currentMultiplier || 1.0,
      elapsedTime: Date.now() - new Date(round.started_at).getTime()
    });
  } catch (error) {
    console.error('Get current round error:', error);
    res.status(500).json({ error: 'Failed to get round' });
  }
});

// Start new round
app.post('/api/rounds/start', async (req, res) => {
  try {
    if (currentRound && gameState !== 'crashed') {
      return res.status(400).json({ error: 'Round already active' });
    }

    // Generate provable fairness seeds
    const serverSeed = crypto.randomBytes(32).toString('hex');
    const serverSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
    const nonce = Date.now();
    
    const crashPoint = generateCrashPoint(serverSeed, 'client_seed_placeholder', nonce);

    // Create round in database
    const { data: round, error } = await supabase
      .from('rounds')
      .insert([
        {
          server_seed_hash: serverSeedHash,
          server_seed: null, // Hidden until round ends
          crash_multiplier: crashPoint,
          status: 'betting',
          started_at: new Date().toISOString()
        }
      ])
      .select()
      .single();

    if (error) throw error;

    currentRound = {
      ...round,
      serverSeed, // Keep in memory
      startTime: Date.now(),
      currentMultiplier: 1.0
    };
    gameState = 'betting';

    // Simulate game progression
    setTimeout(() => {
      if (currentRound && currentRound.id === round.id) {
        gameState = 'running';
        simulateRoundProgress();
      }
    }, 7000); // 7 second betting phase

    res.json({ round, success: true });
  } catch (error) {
    console.error('Start round error:', error);
    res.status(500).json({ error: 'Failed to start round' });
  }
});

// Simulate round progression
function simulateRoundProgress() {
  if (!currentRound || gameState !== 'running') return;

  const elapsed = (Date.now() - (currentRound.startTime + 7000)) / 1000; // seconds since running started
  const multiplier = Math.max(1.0, 1 + (elapsed * 0.1 * Math.random() * 2)); // Rough simulation

  currentRound.currentMultiplier = Math.round(multiplier * 100) / 100;

  // Check if crashed
  if (currentRound.currentMultiplier >= currentRound.crash_multiplier) {
    gameState = 'crashed';
    
    // Update round in database
    supabase
      .from('rounds')
      .update({ 
        status: 'crashed',
        crashed_at: new Date().toISOString(),
        server_seed: currentRound.serverSeed // Reveal seed
      })
      .eq('id', currentRound.id)
      .then(() => {
        // Reset after 3 seconds
        setTimeout(() => {
          currentRound = null;
          gameState = 'waiting';
        }, 3000);
      });
  } else {
    // Continue simulation
    setTimeout(simulateRoundProgress, 100);
  }
}

// Place bet
app.post('/api/bet', async (req, res) => {
  try {
    const { userId, amount, autoCashout } = req.body;

    if (!currentRound || gameState !== 'betting') {
      return res.status(400).json({ error: 'No active betting round' });
    }

    // Check user balance
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('balance_nanotons')
      .eq('id', userId)
      .single();

    if (userError) throw userError;

    if (user.balance_nanotons < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Create bet
    const { data: bet, error: betError } = await supabase
      .from('bets')
      .insert([
        {
          round_id: currentRound.id,
          user_id: userId,
          amount_nanotons: amount,
          auto_cashout: autoCashout || null,
          status: 'placed'
        }
      ])
      .select()
      .single();

    if (betError) throw betError;

    // Update user balance
    const newBalance = user.balance_nanotons - amount;
    await supabase
      .from('users')
      .update({ balance_nanotons: newBalance })
      .eq('id', userId);

    // Add ledger entry
    await supabase
      .from('ledger')
      .insert([
        {
          user_id: userId,
          kind: 'bet',
          amount_nanotons: -amount,
          balance_before: user.balance_nanotons,
          balance_after: newBalance,
          reference_table: 'bets',
          reference_id: bet.id
        }
      ]);

    res.json({ bet, newBalance, success: true });
  } catch (error) {
    console.error('Place bet error:', error);
    res.status(500).json({ error: 'Failed to place bet' });
  }
});

// Cash out
app.post('/api/cashout', async (req, res) => {
  try {
    const { betId } = req.body;

    if (!currentRound || gameState !== 'running') {
      return res.status(400).json({ error: 'No active round for cashout' });
    }

    // Get bet
    const { data: bet, error: betError } = await supabase
      .from('bets')
      .select('*, users(balance_nanotons)')
      .eq('id', betId)
      .eq('status', 'placed')
      .single();

    if (betError) throw betError;

    const currentMultiplier = currentRound.currentMultiplier;
    const payout = Math.floor(bet.amount_nanotons * currentMultiplier);

    // Update bet
    await supabase
      .from('bets')
      .update({ 
        status: 'cashed_out',
        cashout_multiplier: currentMultiplier,
        payout_nanotons: payout,
        cashed_out_at: new Date().toISOString()
      })
      .eq('id', betId);

    // Update user balance
    const newBalance = bet.users.balance_nanotons + payout;
    await supabase
      .from('users')
      .update({ balance_nanotons: newBalance })
      .eq('id', bet.user_id);

    // Add ledger entry
    await supabase
      .from('ledger')
      .insert([
        {
          user_id: bet.user_id,
          kind: 'win',
          amount_nanotons: payout,
          balance_before: bet.users.balance_nanotons,
          balance_after: newBalance,
          reference_table: 'bets',
          reference_id: bet.id
        }
      ]);

    res.json({ 
      success: true, 
      payout, 
      multiplier: currentMultiplier,
      newBalance 
    });
  } catch (error) {
    console.error('Cashout error:', error);
    res.status(500).json({ error: 'Failed to cash out' });
  }
});

app.listen(PORT, () => {
  console.log(`CrashX API server running on port ${PORT}`);
});
