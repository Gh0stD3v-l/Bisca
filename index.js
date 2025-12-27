// ==========================================
// BISCA ONLINE - SERVIDOR MULTIPLAYER v2.2
// Node.js + Socket.io
// CORREÇÕES: Revanche, Chat melhorado, Filtro palavrões, Denúncias
// ==========================================

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// ==========================================
// CONSTANTES DO JOGO
// ==========================================

const SUITS = ['♥', '♦', '♣', '♠'];
const RANKS = ['2', '3', '4', '5', '6', 'Q', 'J', 'K', '7', 'A'];
const VALUES = { '2': 0, '3': 0, '4': 0, '5': 0, '6': 0, 'Q': 2, 'J': 3, 'K': 4, '7': 10, 'A': 11 };
const POWER = { '2': 0, '3': 1, '4': 2, '5': 3, '6': 4, 'Q': 5, 'J': 6, 'K': 7, '7': 8, 'A': 9 };

// Lista de palavrões para filtro (adicione mais conforme necessário)
const PALAVROES = [
  'porra', 'caralho', 'puta', 'merda', 'foda', 'fodase', 'fodasse', 'foder',
  'cu', 'cuzao', 'cuzão', 'arrombado', 'viado', 'viada', 'gay', 'bosta',
  'desgraça', 'desgraçado', 'filho da puta', 'fdp', 'pqp', 'vsf', 'vtnc',
  'otario', 'otário', 'idiota', 'imbecil', 'retardado', 'burro', 'lixo',
  'babaca', 'corno', 'vagabundo', 'vagabunda', 'piranha', 'prostituta',
  'buceta', 'boceta', 'rola', 'pau', 'cacete', 'boquete', 'punheta'
];

// ==========================================
// ESTADO DO SERVIDOR
// ==========================================

const rooms = new Map();
const playerRooms = new Map();
const playerNames = new Map(); // socketId -> nome
let onlinePlayersCount = 0;

// Armazenar denúncias e logs de chat
const reports = [];
const chatLogs = new Map(); // roomId -> array de mensagens

// ==========================================
// FUNÇÕES DE FILTRO E DENÚNCIA
// ==========================================

function containsPalavrao(text) {
  const lowerText = text.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove acentos
    .replace(/[^a-z0-9\s]/g, ''); // Remove caracteres especiais
  
  for (const palavrao of PALAVROES) {
    const normalizedPalavrao = palavrao
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    
    if (lowerText.includes(normalizedPalavrao)) {
      return true;
    }
  }
  return false;
}

function censorMessage(text) {
  let censored = text;
  const lowerText = text.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  
  for (const palavrao of PALAVROES) {
    const normalizedPalavrao = palavrao
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    
    const regex = new RegExp(normalizedPalavrao, 'gi');
    if (regex.test(lowerText)) {
      // Substitui por asteriscos
      const asterisks = '*'.repeat(palavrao.length);
      censored = censored.replace(new RegExp(palavrao, 'gi'), asterisks);
    }
  }
  return censored;
}

function saveReport(report) {
  reports.push({
    ...report,
    id: Date.now(),
    timestamp: new Date().toISOString(),
    status: 'pending' // pending, reviewed, resolved
  });
  
  // Salvar em arquivo (persistência básica)
  try {
    fs.writeFileSync(
      path.join(__dirname, 'reports.json'),
      JSON.stringify(reports, null, 2)
    );
  } catch (err) {
    console.error('Erro ao salvar denúncia:', err);
  }
  
  console.log(`🚨 Nova denúncia registrada: ${report.type} - ${report.reportedPlayer}`);
}

function loadReports() {
  try {
    const data = fs.readFileSync(path.join(__dirname, 'reports.json'), 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return [];
  }
}

// Carregar denúncias existentes
const existingReports = loadReports();
reports.push(...existingReports);

// ==========================================
// BROADCAST
// ==========================================

function broadcastOnlineCount() {
  io.emit('online_count', { count: onlinePlayersCount });
}

// ==========================================
// CLASSE DO JOGO
// ==========================================

class GameRoom {
  constructor(roomId) {
    this.roomId = roomId;
    this.players = [];
    this.deck = [];
    this.trunfo = null;
    this.trunfoSuit = null;
    this.hands = {};
    this.points = {};
    this.table = { cards: {}, lead: null };
    this.currentTurn = null;
    this.phase = 'waiting';
    this.winner = null;
    this.rematchRequests = new Set();
    this.hasBot = false;
    this.isProcessingPlay = false;
    this.chatHistory = []; // Histórico do chat da sala
  }

  isFull() {
    return this.players.length >= 2;
  }

  addPlayer(socketId, name, isBot = false) {
    if (this.isFull()) return false;
    
    this.players.push({ 
      id: this.players.length + 1, 
      name: name || `Jogador ${this.players.length + 1}`,
      socketId,
      isBot
    });
    this.hands[socketId] = [];
    this.points[socketId] = 0;
    
    return true;
  }

  removePlayer(socketId) {
    const playerIndex = this.players.findIndex(p => p.socketId === socketId);
    if (playerIndex === -1) return null;
    
    const removedPlayer = this.players[playerIndex];
    this.players = this.players.filter(p => p.socketId !== socketId);
    delete this.hands[socketId];
    delete this.points[socketId];
    
    return removedPlayer;
  }

  getOpponent(socketId) {
    return this.players.find(p => p.socketId !== socketId);
  }

  addBotReplacement(oldSocketId, oldHand, oldPoints) {
    const botId = 'bot_' + Math.random().toString(36).substr(2, 9);
    
    this.players.push({
      id: 2,
      name: '🤖 Bot',
      socketId: botId,
      isBot: true
    });
    
    this.hands[botId] = oldHand || [];
    this.points[botId] = oldPoints || 0;
    this.hasBot = true;
    
    if (this.currentTurn === oldSocketId) {
      this.currentTurn = botId;
    }
    
    if (this.table.cards[oldSocketId]) {
      this.table.cards[botId] = this.table.cards[oldSocketId];
      delete this.table.cards[oldSocketId];
    }
    if (this.table.lead === oldSocketId) {
      this.table.lead = botId;
    }
    
    return botId;
  }

  createDeck() {
    let newDeck = [];
    SUITS.forEach(suit => {
      RANKS.forEach(rank => {
        newDeck.push({ 
          suit, 
          rank, 
          value: VALUES[rank], 
          power: POWER[rank], 
          id: `${rank}${suit}` 
        });
      });
    });
    for (let i = newDeck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [newDeck[i], newDeck[j]] = [newDeck[j], newDeck[i]];
    }
    return newDeck;
  }

  startGame() {
    if (this.players.length !== 2) return false;
    
    this.deck = this.createDeck();
    this.trunfo = this.deck.pop();
    this.trunfoSuit = this.trunfo.suit;
    this.isProcessingPlay = false;
    
    this.players.forEach(player => {
      this.hands[player.socketId] = [
        this.deck.pop(),
        this.deck.pop(),
        this.deck.pop()
      ];
      this.points[player.socketId] = 0;
    });
    
    this.currentTurn = this.players[Math.floor(Math.random() * 2)].socketId;
    this.phase = 'playing';
    this.table = { cards: {}, lead: null };
    this.winner = null;
    this.rematchRequests.clear(); // Limpa pedidos de revanche
    
    return true;
  }

  playCard(socketId, cardId) {
    if (this.isProcessingPlay) {
      return { success: false, error: 'Aguarde...' };
    }
    
    if (this.phase !== 'playing') return { success: false, error: 'Jogo não está em andamento' };
    if (this.currentTurn !== socketId) return { success: false, error: 'Não é sua vez' };
    
    const hand = this.hands[socketId];
    const cardIndex = hand.findIndex(c => c.id === cardId);
    if (cardIndex === -1) return { success: false, error: 'Carta não encontrada' };
    
    this.isProcessingPlay = true;
    
    const card = hand.splice(cardIndex, 1)[0];
    this.table.cards[socketId] = card;
    
    if (!this.table.lead) {
      this.table.lead = socketId;
    }
    
    if (Object.keys(this.table.cards).length === 2) {
      return { success: true, roundComplete: true };
    }
    
    const opponent = this.getOpponent(socketId);
    this.currentTurn = opponent.socketId;
    
    this.isProcessingPlay = false;
    
    return { success: true, roundComplete: false };
  }

  unlockPlay() {
    this.isProcessingPlay = false;
  }

  botPlay() {
    const bot = this.players.find(p => p.isBot);
    if (!bot || this.currentTurn !== bot.socketId) return null;
    
    const hand = this.hands[bot.socketId];
    if (!hand || hand.length === 0) return null;
    
    let cardToPlay = null;
    const leadCard = Object.values(this.table.cards)[0];
    const trumpSuit = this.trunfoSuit;

    if (!leadCard) {
      const nonTrumps = hand.filter(c => c.suit !== trumpSuit);
      cardToPlay = nonTrumps.length > 0 
        ? nonTrumps.sort((a,b) => a.power - b.power)[0] 
        : hand.sort((a,b) => a.power - b.power)[0];
    } else {
      const winnable = hand.filter(my => {
        if (leadCard.suit === trumpSuit && my.suit === trumpSuit && my.power > leadCard.power) return true;
        if (leadCard.suit !== trumpSuit && my.suit === trumpSuit) return true;
        if (leadCard.suit !== trumpSuit && my.suit === leadCard.suit && my.power > leadCard.power) return true;
        return false;
      });
      
      if (leadCard.value >= 10 && winnable.length > 0) {
        cardToPlay = winnable.sort((a,b) => a.power - b.power)[0];
      } else {
        const trash = hand.sort((a,b) => {
          const aIsTrump = a.suit === trumpSuit ? 1 : 0;
          const bIsTrump = b.suit === trumpSuit ? 1 : 0;
          if (a.value !== b.value) return a.value - b.value;
          if (aIsTrump !== bIsTrump) return aIsTrump - bIsTrump;
          return a.power - b.power;
        });
        cardToPlay = trash[0];
      }
    }
    
    return this.playCard(bot.socketId, cardToPlay.id);
  }

  resolveRound() {
    const [p1, p2] = this.players;
    const card1 = this.table.cards[p1.socketId];
    const card2 = this.table.cards[p2.socketId];
    
    if (!card1 || !card2) return null;
    
    let winnerId;
    const leadId = this.table.lead;
    const followId = leadId === p1.socketId ? p2.socketId : p1.socketId;
    
    const leadCard = this.table.cards[leadId];
    const followCard = this.table.cards[followId];
    
    const leadIsTrump = leadCard.suit === this.trunfoSuit;
    const followIsTrump = followCard.suit === this.trunfoSuit;
    
    if (leadIsTrump && !followIsTrump) {
      winnerId = leadId;
    } else if (!leadIsTrump && followIsTrump) {
      winnerId = followId;
    } else if (leadCard.suit !== followCard.suit) {
      winnerId = leadId;
    } else {
      winnerId = leadCard.power > followCard.power ? leadId : followId;
    }
    
    const roundPoints = card1.value + card2.value;
    this.points[winnerId] += roundPoints;
    
    const winner = this.players.find(p => p.socketId === winnerId);
    
    const result = {
      winnerId,
      visibleWinnerId: winnerId,
      winnerName: winner ? winner.name : 'Jogador',
      roundPoints,
      cards: { ...this.table.cards },
      scores: { ...this.points }
    };
    
    this.table = { cards: {}, lead: null };
    this.currentTurn = winnerId;
    
    return result;
  }

  drawCards(winnerId) {
    const drawn = {};
    
    const winnerPlayer = this.players.find(p => p.socketId === winnerId);
    const otherPlayer = this.players.find(p => p.socketId !== winnerId);
    
    if (!winnerPlayer || !otherPlayer) return drawn;
    
    const order = [winnerPlayer, otherPlayer];
    
    order.forEach(player => {
      if (this.hands[player.socketId] && this.hands[player.socketId].length < 3) {
        let card = null;
        if (this.deck.length > 0) {
          card = this.deck.pop();
        } else if (this.trunfo) {
          card = this.trunfo;
          this.trunfo = null;
        }
        
        if (card) {
          this.hands[player.socketId].push(card);
          drawn[player.socketId] = card;
        }
      }
    });
    
    return drawn;
  }

  checkGameOver() {
    const player1 = this.players[0];
    const player2 = this.players[1];
    
    if (!player1 || !player2) return { gameOver: false };
    
    const hand1 = this.hands[player1.socketId] || [];
    const hand2 = this.hands[player2.socketId] || [];
    
    const allEmpty = hand1.length === 0 && hand2.length === 0;
    const noCards = this.deck.length === 0 && !this.trunfo;
    
    if (allEmpty && noCards) {
      this.phase = 'finished';
      
      const points1 = this.points[player1.socketId] || 0;
      const points2 = this.points[player2.socketId] || 0;
      
      if (points1 > points2) {
        this.winner = player1.socketId;
      } else if (points2 > points1) {
        this.winner = player2.socketId;
      } else {
        this.winner = 'draw';
      }
      
      return {
        gameOver: true,
        winner: this.winner,
        winnerName: this.winner === 'draw' ? 'Empate' : this.players.find(p => p.socketId === this.winner)?.name || 'Jogador',
        finalScores: { ...this.points },
        playerScores: {
          [player1.socketId]: points1,
          [player2.socketId]: points2
        }
      };
    }
    
    return { gameOver: false };
  }

  requestRematch(socketId) {
    this.rematchRequests.add(socketId);
    
    const humanPlayers = this.players.filter(p => !p.isBot);
    
    // Se só tem 1 humano + bot, aceita direto
    if (humanPlayers.length === 1 && this.hasBot) {
      return { accepted: true };
    }
    
    // Se os dois jogadores pediram revanche
    if (this.rematchRequests.size >= 2) {
      return { accepted: true };
    }
    
    return { accepted: false, waiting: true };
  }

  // Método para aceitar revanche do oponente
  acceptRematch(socketId) {
    this.rematchRequests.add(socketId);
    
    if (this.rematchRequests.size >= 2) {
      return { accepted: true };
    }
    
    return { accepted: false };
  }

  getStateForPlayer(socketId) {
    const opponent = this.getOpponent(socketId);
    const myPoints = this.points[socketId] || 0;
    const opponentPoints = opponent ? (this.points[opponent.socketId] || 0) : 0;
    
    let gameResult = null;
    if (this.phase === 'finished') {
      if (this.winner === 'draw') {
        gameResult = 'draw';
      } else if (this.winner === socketId) {
        gameResult = 'victory';
      } else {
        gameResult = 'defeat';
      }
    }
    
    return {
      roomId: this.roomId,
      phase: this.phase,
      myHand: this.hands[socketId] || [],
      opponentCardCount: opponent ? (this.hands[opponent.socketId]?.length || 0) : 0,
      opponentName: opponent?.name || 'Aguardando...',
      opponentIsBot: opponent?.isBot || false,
      myPoints,
      opponentPoints,
      trunfo: this.trunfo,
      trunfoSuit: this.trunfoSuit,
      deckCount: this.deck.length,
      table: {
        myCard: this.table.cards[socketId] || null,
        opponentCard: opponent ? (this.table.cards[opponent.socketId] || null) : null,
        iAmLead: this.table.lead === socketId
      },
      isMyTurn: this.currentTurn === socketId && !this.isProcessingPlay,
      winner: this.winner,
      gameResult,
      rematchRequests: Array.from(this.rematchRequests),
      hasBot: this.hasBot,
      opponentWantsRematch: opponent ? this.rematchRequests.has(opponent.socketId) : false
    };
  }
}

// ==========================================
// FUNÇÕES AUXILIARES
// ==========================================

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function findOrCreateRoom() {
  for (const [roomId, room] of rooms) {
    if (room.phase === 'waiting' && room.players.length === 1 && !room.hasBot) {
      return room;
    }
  }
  
  const roomId = generateRoomId();
  const room = new GameRoom(roomId);
  rooms.set(roomId, room);
  return room;
}

function scheduleBotPlay(room, io) {
  const bot = room.players.find(p => p.isBot);
  if (!bot || room.currentTurn !== bot.socketId || room.phase !== 'playing') return;
  
  setTimeout(() => {
    if (room.phase !== 'playing') return;
    
    const result = room.botPlay();
    if (!result || !result.success) return;
    
    const human = room.players.find(p => !p.isBot);
    if (human) {
      io.to(human.socketId).emit('card_played', room.getStateForPlayer(human.socketId));
    }
    
    if (result.roundComplete) {
      setTimeout(() => {
        const roundResult = room.resolveRound();
        room.unlockPlay();
        
        if (roundResult) {
          if (human) {
            io.to(human.socketId).emit('round_result', {
              ...roundResult,
              iWon: roundResult.winnerId === human.socketId
            });
          }
          
          setTimeout(() => {
            const drawn = room.drawCards(roundResult.winnerId);
            
            if (human) {
              io.to(human.socketId).emit('cards_drawn', {
                ...room.getStateForPlayer(human.socketId),
                drawnCard: drawn[human.socketId] || null
              });
            }
            
            const gameOverResult = room.checkGameOver();
            if (gameOverResult.gameOver) {
              if (human) {
                const humanResult = gameOverResult.winner === human.socketId ? 'victory' : 
                                   gameOverResult.winner === 'draw' ? 'draw' : 'defeat';
                io.to(human.socketId).emit('game_over', {
                  ...gameOverResult,
                  myResult: humanResult
                });
              }
            } else {
              scheduleBotPlay(room, io);
            }
          }, 1000);
        }
      }, 1500);
    } else {
      scheduleBotPlay(room, io);
    }
  }, 1200);
}

// ==========================================
// SOCKET.IO HANDLERS
// ==========================================

io.on('connection', (socket) => {
  console.log(`🟢 Jogador conectado: ${socket.id}`);
  
  onlinePlayersCount++;
  broadcastOnlineCount();
  socket.emit('online_count', { count: onlinePlayersCount });

  socket.on('get_online_count', () => {
    socket.emit('online_count', { count: onlinePlayersCount });
  });

  // MATCHMAKING
  socket.on('find_match', (data) => {
    const playerName = data?.name || 'Anônimo';
    playerNames.set(socket.id, playerName);
    console.log(`🔍 ${playerName} procurando partida...`);
    
    const room = findOrCreateRoom();
    room.addPlayer(socket.id, playerName);
    playerRooms.set(socket.id, room.roomId);
    socket.join(room.roomId);
    
    socket.emit('joined_room', { 
      roomId: room.roomId,
      playersCount: room.players.length 
    });
    
    if (room.isFull()) {
      room.startGame();
      
      room.players.forEach(player => {
        if (!player.isBot) {
          io.to(player.socketId).emit('game_start', room.getStateForPlayer(player.socketId));
        }
      });
      
      scheduleBotPlay(room, io);
      console.log(`🎮 Partida iniciada na sala ${room.roomId}`);
    } else {
      socket.emit('waiting_opponent', { roomId: room.roomId });
    }
  });

  // CRIAR SALA PRIVADA
  socket.on('create_private_room', (data) => {
    const playerName = data?.name || 'Anfitrião';
    playerNames.set(socket.id, playerName);
    const roomId = generateRoomId();
    const room = new GameRoom(roomId);
    
    room.addPlayer(socket.id, playerName);
    rooms.set(roomId, room);
    playerRooms.set(socket.id, roomId);
    socket.join(roomId);
    
    socket.emit('private_room_created', { roomId });
    console.log(`🏠 Sala privada criada: ${roomId}`);
  });

  // ENTRAR SALA PRIVADA
  socket.on('join_private_room', (data) => {
    const { roomId, name } = data;
    const playerName = name || 'Convidado';
    playerNames.set(socket.id, playerName);
    const room = rooms.get(roomId);
    
    if (!room) {
      socket.emit('error', { message: 'Sala não encontrada' });
      return;
    }
    
    if (room.isFull()) {
      socket.emit('error', { message: 'Sala cheia' });
      return;
    }
    
    room.addPlayer(socket.id, playerName);
    playerRooms.set(socket.id, roomId);
    socket.join(roomId);
    
    if (room.isFull()) {
      room.startGame();
      
      room.players.forEach(player => {
        if (!player.isBot) {
          io.to(player.socketId).emit('game_start', room.getStateForPlayer(player.socketId));
        }
      });
      
      console.log(`🎮 Partida iniciada na sala privada ${roomId}`);
    }
  });

  // JOGAR CARTA
  socket.on('play_card', (data) => {
    const roomId = playerRooms.get(socket.id);
    const room = rooms.get(roomId);
    
    if (!room) {
      socket.emit('error', { message: 'Sala não encontrada' });
      return;
    }
    
    const result = room.playCard(socket.id, data.cardId);
    
    if (!result.success) {
      socket.emit('error', { message: result.error });
      return;
    }
    
    room.players.forEach(player => {
      if (!player.isBot) {
        io.to(player.socketId).emit('card_played', room.getStateForPlayer(player.socketId));
      }
    });
    
    if (result.roundComplete) {
      setTimeout(() => {
        const roundResult = room.resolveRound();
        room.unlockPlay();
        
        if (roundResult) {
          room.players.forEach(player => {
            if (!player.isBot) {
              io.to(player.socketId).emit('round_result', {
                ...roundResult,
                iWon: roundResult.winnerId === player.socketId
              });
            }
          });
          
          setTimeout(() => {
            const drawn = room.drawCards(roundResult.winnerId);
            
            room.players.forEach(player => {
              if (!player.isBot) {
                io.to(player.socketId).emit('cards_drawn', {
                  ...room.getStateForPlayer(player.socketId),
                  drawnCard: drawn[player.socketId] || null
                });
              }
            });
            
            const gameOverResult = room.checkGameOver();
            if (gameOverResult.gameOver) {
              room.players.forEach(player => {
                if (!player.isBot) {
                  const playerResult = gameOverResult.winner === player.socketId ? 'victory' : 
                                      gameOverResult.winner === 'draw' ? 'draw' : 'defeat';
                  io.to(player.socketId).emit('game_over', {
                    ...gameOverResult,
                    myResult: playerResult
                  });
                }
              });
            } else {
              scheduleBotPlay(room, io);
            }
          }, 1000);
        }
      }, 1500);
    } else {
      scheduleBotPlay(room, io);
    }
  });

  // PEDIR REVANCHE
  socket.on('rematch', () => {
    const roomId = playerRooms.get(socket.id);
    const room = rooms.get(roomId);
    
    if (!room) return;
    
    const result = room.requestRematch(socket.id);
    
    // Notifica o oponente que pedimos revanche
    const opponent = room.getOpponent(socket.id);
    if (opponent && !opponent.isBot) {
      io.to(opponent.socketId).emit('rematch_requested', {
        from: room.players.find(p => p.socketId === socket.id)?.name || 'Oponente'
      });
    }
    
    if (result.accepted) {
      // Reinicia o jogo!
      room.startGame();
      
      room.players.forEach(player => {
        if (!player.isBot) {
          io.to(player.socketId).emit('rematch_accepted');
          io.to(player.socketId).emit('game_start', room.getStateForPlayer(player.socketId));
        }
      });
      
      scheduleBotPlay(room, io);
      console.log(`🔄 Revanche na sala ${roomId}`);
    } else {
      socket.emit('rematch_waiting', { message: 'Aguardando oponente aceitar revanche...' });
    }
  });

  // ACEITAR REVANCHE (novo evento)
  socket.on('accept_rematch', () => {
    const roomId = playerRooms.get(socket.id);
    const room = rooms.get(roomId);
    
    if (!room) return;
    
    const result = room.acceptRematch(socket.id);
    
    if (result.accepted) {
      room.startGame();
      
      room.players.forEach(player => {
        if (!player.isBot) {
          io.to(player.socketId).emit('rematch_accepted');
          io.to(player.socketId).emit('game_start', room.getStateForPlayer(player.socketId));
        }
      });
      
      scheduleBotPlay(room, io);
      console.log(`🔄 Revanche aceita na sala ${roomId}`);
    }
  });

  // CHAT COM FILTRO DE PALAVRÕES
  socket.on('chat_message', (data) => {
    const roomId = playerRooms.get(socket.id);
    if (!roomId) return;
    
    const room = rooms.get(roomId);
    const player = room?.players.find(p => p.socketId === socket.id);
    const playerName = player?.name || 'Anônimo';
    
    let message = data.message;
    let wasCensored = false;
    
    // Verifica e censura palavrões
    if (containsPalavrao(message)) {
      message = censorMessage(message);
      wasCensored = true;
    }
    
    // Salva no histórico
    const chatEntry = {
      sender: playerName,
      senderId: socket.id,
      message: data.message, // Mensagem original (para denúncias)
      censoredMessage: message,
      timestamp: new Date().toISOString(),
      wasCensored
    };
    
    if (!room.chatHistory) room.chatHistory = [];
    room.chatHistory.push(chatEntry);
    
    // Limita histórico a 100 mensagens
    if (room.chatHistory.length > 100) {
      room.chatHistory = room.chatHistory.slice(-100);
    }
    
    // Envia mensagem censurada para todos
    io.to(roomId).emit('chat_message', {
      sender: playerName,
      message: message,
      wasCensored
    });
    
    // Avisa quem enviou que foi censurado
    if (wasCensored) {
      socket.emit('message_censored', {
        warning: 'Sua mensagem continha palavras impróprias e foi censurada.'
      });
    }
  });

  // SISTEMA DE DENÚNCIA
  socket.on('report_player', (data) => {
    const roomId = playerRooms.get(socket.id);
    const room = rooms.get(roomId);
    
    if (!room) {
      socket.emit('report_error', { message: 'Sala não encontrada' });
      return;
    }
    
    const reporter = room.players.find(p => p.socketId === socket.id);
    const reported = room.getOpponent(socket.id);
    
    if (!reported || reported.isBot) {
      socket.emit('report_error', { message: 'Não é possível denunciar este jogador' });
      return;
    }
    
    const report = {
      type: data.type, // 'palavrao', 'hack', 'outro'
      reason: data.reason || '',
      reporterName: reporter?.name || 'Anônimo',
      reporterId: socket.id,
      reportedPlayer: reported.name,
      reportedId: reported.socketId,
      roomId: roomId,
      chatHistory: room.chatHistory || [], // Inclui histórico do chat
      gameState: {
        myPoints: room.points[socket.id],
        opponentPoints: room.points[reported.socketId],
        phase: room.phase
      }
    };
    
    saveReport(report);
    
    socket.emit('report_success', { 
      message: 'Denúncia enviada com sucesso! Nossa equipe irá analisar.' 
    });
    
    console.log(`🚨 Denúncia: ${reporter?.name} denunciou ${reported.name} por ${data.type}`);
  });

  // DESCONEXÃO
  socket.on('disconnect', () => {
    onlinePlayersCount = Math.max(0, onlinePlayersCount - 1);
    broadcastOnlineCount();
    
    const roomId = playerRooms.get(socket.id);
    
    if (roomId) {
      const room = rooms.get(roomId);
      
      if (room) {
        const disconnectedPlayer = room.players.find(p => p.socketId === socket.id);
        const opponent = room.getOpponent(socket.id);
        
        if (opponent && !opponent.isBot && room.phase === 'playing') {
          const oldHand = room.hands[socket.id] || [];
          const oldPoints = room.points[socket.id] || 0;
          
          room.removePlayer(socket.id);
          const botId = room.addBotReplacement(socket.id, oldHand, oldPoints);
          
          io.to(opponent.socketId).emit('opponent_replaced_by_bot', {
            message: `${disconnectedPlayer?.name || 'Oponente'} saiu. Um bot assumiu o lugar!`
          });
          
          io.to(opponent.socketId).emit('game_state_update', room.getStateForPlayer(opponent.socketId));
          
          scheduleBotPlay(room, io);
          
          console.log(`🤖 Bot substituiu jogador na sala ${roomId}`);
        } else if (opponent && !opponent.isBot) {
          io.to(opponent.socketId).emit('opponent_disconnected', {
            message: 'Seu oponente desconectou.'
          });
          
          room.removePlayer(socket.id);
        } else {
          room.removePlayer(socket.id);
        }
        
        if (room.players.filter(p => !p.isBot).length === 0) {
          rooms.delete(roomId);
          console.log(`🗑️ Sala ${roomId} removida`);
        }
      }
      
      playerRooms.delete(socket.id);
    }
    
    playerNames.delete(socket.id);
    console.log(`🔴 Jogador desconectado: ${socket.id} | Online: ${onlinePlayersCount}`);
  });
});

// ==========================================
// ROTAS HTTP
// ==========================================

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    game: 'Bisca Multiplayer v2.2',
    rooms: rooms.size,
    players: onlinePlayersCount
  });
});

app.get('/stats', (req, res) => {
  const roomStats = [];
  rooms.forEach((room, id) => {
    roomStats.push({
      roomId: id,
      players: room.players.length,
      phase: room.phase,
      hasBot: room.hasBot
    });
  });
  
  res.json({
    totalRooms: rooms.size,
    totalPlayers: onlinePlayersCount,
    rooms: roomStats
  });
});

app.get('/online', (req, res) => {
  res.json({ count: onlinePlayersCount });
});

// ROTA PARA ADMIN VER DENÚNCIAS (proteger depois com autenticação)
app.get('/admin/reports', (req, res) => {
  // Aqui você pode adicionar autenticação básica depois
  const adminKey = req.query.key;
  
  // Chave simples de admin (mude para algo mais seguro depois!)
  if (adminKey !== 'bisca_admin_2024') {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  
  res.json({
    total: reports.length,
    pending: reports.filter(r => r.status === 'pending').length,
    reports: reports.slice(-50) // Últimas 50 denúncias
  });
});

// ==========================================
// INICIAR SERVIDOR
// ==========================================

const PORT = process.env.PORT || 10000;

httpServer.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║     🃏 BISCA ONLINE - SERVIDOR v2.2 🃏   ║
╠══════════════════════════════════════════╣
║  Status: ONLINE                          ║
║  Porta: ${PORT}                            ║
║  WebSocket: Ativo                        ║
║  Filtro Palavrões: Ativo                 ║
║  Sistema Denúncias: Ativo                ║
╚══════════════════════════════════════════╝
  `);
});
