// ==========================================
// BISCA ONLINE - SERVIDOR MULTIPLAYER
// Node.js + Socket.io
// ==========================================

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*", // Em produção, especifique o domínio do frontend
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

// ==========================================
// ESTADO DO SERVIDOR
// ==========================================

const rooms = new Map();        // roomId -> GameRoom
const playerRooms = new Map();  // socketId -> roomId
const waitingQueue = [];        // Fila de matchmaking

// ==========================================
// CLASSES
// ==========================================

class GameRoom {
  constructor(roomId) {
    this.roomId = roomId;
    this.players = [];          // [{ id, name, socketId }]
    this.deck = [];
    this.trunfo = null;
    this.trunfoSuit = null;
    this.hands = {};            // { socketId: [cards] }
    this.points = {};           // { socketId: points }
    this.table = { cards: {}, lead: null };
    this.currentTurn = null;    // socketId de quem deve jogar
    this.phase = 'waiting';     // waiting, playing, finished
    this.winner = null;
  }

  isFull() {
    return this.players.length >= 2;
  }

  addPlayer(socketId, name) {
    if (this.isFull()) return false;
    
    this.players.push({ 
      id: this.players.length + 1, 
      name: name || `Jogador ${this.players.length + 1}`,
      socketId 
    });
    this.hands[socketId] = [];
    this.points[socketId] = 0;
    
    return true;
  }

  removePlayer(socketId) {
    this.players = this.players.filter(p => p.socketId !== socketId);
    delete this.hands[socketId];
    delete this.points[socketId];
  }

  getOpponent(socketId) {
    return this.players.find(p => p.socketId !== socketId);
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
    // Embaralhar
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
    
    // Distribuir 3 cartas para cada jogador
    this.players.forEach(player => {
      this.hands[player.socketId] = [
        this.deck.pop(),
        this.deck.pop(),
        this.deck.pop()
      ];
      this.points[player.socketId] = 0;
    });
    
    // Primeiro jogador começa (aleatório)
    this.currentTurn = this.players[Math.floor(Math.random() * 2)].socketId;
    this.phase = 'playing';
    this.table = { cards: {}, lead: null };
    
    return true;
  }

  playCard(socketId, cardId) {
    // Validações
    if (this.phase !== 'playing') return { success: false, error: 'Jogo não está em andamento' };
    if (this.currentTurn !== socketId) return { success: false, error: 'Não é sua vez' };
    
    const hand = this.hands[socketId];
    const cardIndex = hand.findIndex(c => c.id === cardId);
    if (cardIndex === -1) return { success: false, error: 'Carta não encontrada' };
    
    // Remove carta da mão e coloca na mesa
    const card = hand.splice(cardIndex, 1)[0];
    this.table.cards[socketId] = card;
    
    if (!this.table.lead) {
      this.table.lead = socketId;
    }
    
    // Verificar se ambos jogaram
    if (Object.keys(this.table.cards).length === 2) {
      return { success: true, roundComplete: true };
    }
    
    // Passar a vez para o oponente
    const opponent = this.getOpponent(socketId);
    this.currentTurn = opponent.socketId;
    
    return { success: true, roundComplete: false };
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
      winnerId = leadId; // Se não seguiu naipe e não é trunfo, quem puxou ganha
    } else {
      winnerId = leadCard.power > followCard.power ? leadId : followId;
    }
    
    // Calcular pontos
    const roundPoints = card1.value + card2.value;
    this.points[winnerId] += roundPoints;
    
    // Limpar mesa
    const result = {
      winnerId,
      winnerName: this.players.find(p => p.socketId === winnerId).name,
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
    const order = winnerId === this.players[0].socketId 
      ? [this.players[0], this.players[1]] 
      : [this.players[1], this.players[0]];
    
    order.forEach(player => {
      if (this.hands[player.socketId].length < 3) {
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
    const allEmpty = this.players.every(p => this.hands[p.socketId].length === 0);
    const noCards = this.deck.length === 0 && !this.trunfo;
    
    if (allEmpty && noCards) {
      this.phase = 'finished';
      
      const [p1, p2] = this.players;
      if (this.points[p1.socketId] > this.points[p2.socketId]) {
        this.winner = p1.socketId;
      } else if (this.points[p2.socketId] > this.points[p1.socketId]) {
        this.winner = p2.socketId;
      } else {
        this.winner = 'draw';
      }
      
      return {
        gameOver: true,
        winner: this.winner,
        winnerName: this.winner === 'draw' ? 'Empate' : this.players.find(p => p.socketId === this.winner).name,
        finalScores: { ...this.points }
      };
    }
    
    return { gameOver: false };
  }

  getStateForPlayer(socketId) {
    const opponent = this.getOpponent(socketId);
    
    return {
      roomId: this.roomId,
      phase: this.phase,
      myHand: this.hands[socketId] || [],
      opponentCardCount: opponent ? (this.hands[opponent.socketId]?.length || 0) : 0,
      opponentName: opponent?.name || 'Aguardando...',
      myPoints: this.points[socketId] || 0,
      opponentPoints: opponent ? (this.points[opponent.socketId] || 0) : 0,
      trunfo: this.trunfo,
      trunfoSuit: this.trunfoSuit,
      deckCount: this.deck.length,
      table: {
        myCard: this.table.cards[socketId] || null,
        opponentCard: opponent ? (this.table.cards[opponent.socketId] || null) : null,
        iAmLead: this.table.lead === socketId
      },
      isMyTurn: this.currentTurn === socketId,
      winner: this.winner
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
  // Procura sala com 1 jogador esperando
  for (const [roomId, room] of rooms) {
    if (room.phase === 'waiting' && room.players.length === 1) {
      return room;
    }
  }
  
  // Cria nova sala
  const roomId = generateRoomId();
  const room = new GameRoom(roomId);
  rooms.set(roomId, room);
  return room;
}

// ==========================================
// SOCKET.IO HANDLERS
// ==========================================

io.on('connection', (socket) => {
  console.log(`🟢 Jogador conectado: ${socket.id}`);

  // ========== MATCHMAKING ==========
  socket.on('find_match', (data) => {
    const playerName = data?.name || 'Anônimo';
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
      
      // Envia estado inicial para cada jogador
      room.players.forEach(player => {
        io.to(player.socketId).emit('game_start', room.getStateForPlayer(player.socketId));
      });
      
      console.log(`🎮 Partida iniciada na sala ${room.roomId}`);
    } else {
      socket.emit('waiting_opponent', { roomId: room.roomId });
    }
  });

  // ========== CRIAR SALA PRIVADA ==========
  socket.on('create_private_room', (data) => {
    const playerName = data?.name || 'Anfitrião';
    const roomId = generateRoomId();
    const room = new GameRoom(roomId);
    
    room.addPlayer(socket.id, playerName);
    rooms.set(roomId, room);
    playerRooms.set(socket.id, roomId);
    socket.join(roomId);
    
    socket.emit('private_room_created', { roomId });
    console.log(`🏠 Sala privada criada: ${roomId}`);
  });

  // ========== ENTRAR SALA PRIVADA ==========
  socket.on('join_private_room', (data) => {
    const { roomId, name } = data;
    const playerName = name || 'Convidado';
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
        io.to(player.socketId).emit('game_start', room.getStateForPlayer(player.socketId));
      });
      
      console.log(`🎮 Partida iniciada na sala privada ${roomId}`);
    }
  });

  // ========== JOGAR CARTA ==========
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
    
    // Notificar todos da carta jogada
    room.players.forEach(player => {
      io.to(player.socketId).emit('card_played', room.getStateForPlayer(player.socketId));
    });
    
    if (result.roundComplete) {
      // Aguardar um pouco antes de resolver
      setTimeout(() => {
        const roundResult = room.resolveRound();
        
        if (roundResult) {
          io.to(roomId).emit('round_result', roundResult);
          
          // Pescar cartas
          setTimeout(() => {
            const drawn = room.drawCards(roundResult.winnerId);
            
            // Enviar estado atualizado para cada jogador
            room.players.forEach(player => {
              io.to(player.socketId).emit('cards_drawn', {
                ...room.getStateForPlayer(player.socketId),
                drawnCard: drawn[player.socketId] || null
              });
            });
            
            // Verificar fim de jogo
            const gameOverResult = room.checkGameOver();
            if (gameOverResult.gameOver) {
              io.to(roomId).emit('game_over', gameOverResult);
            }
          }, 1000);
        }
      }, 1500);
    }
  });

  // ========== REINICIAR JOGO ==========
  socket.on('rematch', () => {
    const roomId = playerRooms.get(socket.id);
    const room = rooms.get(roomId);
    
    if (!room || room.players.length !== 2) return;
    
    room.startGame();
    
    room.players.forEach(player => {
      io.to(player.socketId).emit('game_start', room.getStateForPlayer(player.socketId));
    });
    
    console.log(`🔄 Revanche na sala ${roomId}`);
  });

  // ========== DESCONEXÃO ==========
  socket.on('disconnect', () => {
    const roomId = playerRooms.get(socket.id);
    
    if (roomId) {
      const room = rooms.get(roomId);
      
      if (room) {
        const opponent = room.getOpponent(socket.id);
        
        if (opponent) {
          io.to(opponent.socketId).emit('opponent_disconnected', {
            message: 'Seu oponente desconectou. Você venceu!'
          });
        }
        
        room.removePlayer(socket.id);
        
        if (room.players.length === 0) {
          rooms.delete(roomId);
          console.log(`🗑️ Sala ${roomId} removida`);
        }
      }
      
      playerRooms.delete(socket.id);
    }
    
    console.log(`🔴 Jogador desconectado: ${socket.id}`);
  });

  // ========== CHAT (Opcional) ==========
  socket.on('chat_message', (data) => {
    const roomId = playerRooms.get(socket.id);
    if (roomId) {
      const room = rooms.get(roomId);
      const player = room?.players.find(p => p.socketId === socket.id);
      io.to(roomId).emit('chat_message', {
        sender: player?.name || 'Anônimo',
        message: data.message
      });
    }
  });
});

// ==========================================
// ROTAS HTTP (Status/Health)
// ==========================================

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    game: 'Bisca Multiplayer',
    rooms: rooms.size,
    players: playerRooms.size
  });
});

app.get('/stats', (req, res) => {
  const roomStats = [];
  rooms.forEach((room, id) => {
    roomStats.push({
      roomId: id,
      players: room.players.length,
      phase: room.phase
    });
  });
  
  res.json({
    totalRooms: rooms.size,
    totalPlayers: playerRooms.size,
    rooms: roomStats
  });
});

// ==========================================
// INICIAR SERVIDOR
// ==========================================

const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║     🃏 BISCA ONLINE - SERVIDOR 🃏        ║
╠══════════════════════════════════════════╣
║  Status: ONLINE                          ║
║  Porta: ${PORT}                             ║
║  WebSocket: Ativo                        ║
╚══════════════════════════════════════════╝
  `);
});
