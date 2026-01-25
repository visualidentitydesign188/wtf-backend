<script setup>
import { ref, onMounted, onUnmounted, reactive, nextTick, computed } from "vue";
import { io } from 'socket.io-client';

/**
 * Puzzle Settings - Configure all puzzle options here
 */
const PUZZLE_SETTINGS = {
  // Grid size: 'large' (5x6), 'medium' (8x10), 'small' (10x12)
  gridSize: "small",

  // Board scale factor (1.0 = 100%, 0.85 = 85%, etc.)
  scaleFactor: 1.0,

  // Rotation range in degrees (0 = no rotation, 45 = light rotation, 180 = chaos)
  rotationRange: 45,

  // Show guide image behind puzzle pieces
  guideVisible: true,

  // Default image URL (or set to null to load a different image)
  defaultImageUrl:
    "https://plus.unsplash.com/premium_photo-1661964177687-57387c2cbd14?q=80&w=1740&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D",

  // Seed for puzzle scrambling (same seed = same puzzle layout for all users)
  // Set to null to use server-generated seed, or set a fixed number for consistent testing
  scrambleSeed: null,
};

/**
 * Configuration & State
 */
const CONFIG = {
  snapDistance: 25, // pixels
  websocketThrottle: 50, // ms - throttle WebSocket updates to reduce bandwidth
};

const state = reactive({
  rows: 8,
  cols: 10,
  pieces: [],
  width: 0, // Board width (from Tailwind)
  height: 0, // Board height (from Tailwind)
  imageWidth: 0, // Actual scaled image width
  imageHeight: 0, // Actual scaled image height
  imageX: 0, // Image X position on board (for centering)
  imageY: 0, // Image Y position on board (for centering)
  pieceWidth: 0,
  pieceHeight: 0,
  isDragging: false,
  draggedPiece: null,
  dragOffsetX: 0,
  dragOffsetY: 0,
  completedCount: 0,
  originalImage: null,
  scrambleSeed: null, // Seed for puzzle scrambling (from server or settings)
});

// WebSocket state
const socket = ref(null);
const myUserId = ref(null);
const remotePieceDrags = reactive({}); // Track pieces being dragged by other users: { pieceId: { userId, x, y, color, name } }
const pendingServerState = ref(null);

const isWin = ref(false);
const imageLoaded = ref(false);
const waitingForServer = ref(true);

// DOM Refs
const elGameContainer = ref(null);
const elBoardContainer = ref(null);
const elPuzzleBoard = ref(null);
const elLeftSidebar = ref(null);
const elRightSidebar = ref(null);

/**
 * Seed-based Random Number Generator
 * Uses a seeded PRNG to ensure all users get the same puzzle layout
 */
class SeededRandom {
  constructor(seed) {
    this.seed = seed || Date.now();
    // Use a simple LCG (Linear Congruential Generator)
    this.m = 2 ** 48;
    this.a = 25214903917;
    this.c = 11;
  }

  next() {
    this.seed = (this.a * this.seed + this.c) % this.m;
    return this.seed / this.m;
  }

  random() {
    return this.next();
  }

  // Reset with a new seed
  setSeed(seed) {
    this.seed = seed;
  }
}

let seededRandom = null;

/**
 * WebSocket Integration
 */
function initWebSocket() {
  if (!socket.value) {
    const wsUrl = useRuntimeConfig().public.websocketUrl;
    socket.value = io(wsUrl);

    socket.value.on('connect', () => {
      console.log('Puzzle WebSocket connected');
      myUserId.value = socket.value.id;

      // Request puzzle state from server
      socket.value.emit('puzzle_request_state');
    });

    socket.value.on('puzzle_state_sync', (serverState) => {
      console.log('Received puzzle state from server');
      if (state.originalImage) {
        loadPuzzleState(serverState);
      } else {
        pendingServerState.value = serverState;
      }
      waitingForServer.value = false;
    });

    socket.value.on('puzzle_no_state', () => {
      console.log('No puzzle state on server');
      waitingForServer.value = false;
      // Request initialization if image is loaded
      if (state.originalImage && state.pieces.length === 0) {
        requestPuzzleInitialization(state.originalImage);
      }
    });

    socket.value.on('puzzle_completed', () => {
      isWin.value = true;
    });

    socket.value.on('puzzle_reset', () => {
      // Full reset
      elPuzzleBoard.value.innerHTML = "";
      elLeftSidebar.value.innerHTML = "";
      elRightSidebar.value.innerHTML = "";
      state.pieces = [];
      state.completedCount = 0;
      isWin.value = false;
      pendingServerState.value = null;

      // Re-initialize if we have image
      if (state.originalImage) {
        // Add small delay to ensure cleanup
        setTimeout(() => {
          socket.value.emit('puzzle_request_state');
        }, 100);
      }
    });

    socket.value.on('puzzle_piece_drag_start', (data) => {
      console.log('Received puzzle_piece_drag_start', data, 'myUserId:', myUserId.value);
      if (data.userId !== myUserId.value) {
        handleRemoteDragStart(data);
      }
    });

    socket.value.on('puzzle_piece_drag_move', (data) => {
      if (data.userId !== myUserId.value) {
        handleRemoteDragMove(data);
      }
    });

    socket.value.on('puzzle_piece_drag_end', (data) => {
      console.log('Received puzzle_piece_drag_end', data);
      if (data.userId !== myUserId.value) {
        handleRemoteDragEnd(data);
      }
    });

    socket.value.on('puzzle_piece_snap', (data) => {
      if (data.userId !== myUserId.value) {
        handleRemotePieceSnap(data);
      }
    });

    socket.value.on('connect_error', (err) => {
      console.error('Puzzle WebSocket connection error:', err);
    });
  }
}

function handleRemoteDragStart(data) {
  console.log('handleRemoteDragStart called with:', data);
  const piece = state.pieces.find(p => p.id === data.pieceId);
  if (!piece) {
    console.warn('Piece not found for remote drag start:', data.pieceId, 'Available pieces:', state.pieces.map(p => p.id));
    return;
  }
  if (piece.snapped) {
    console.warn('Piece already snapped:', data.pieceId);
    return;
  }

  // Store remote drag info
  remotePieceDrags[data.pieceId] = {
    userId: data.userId,
    userName: data.userName || 'User',
    userColor: data.userColor || '#3b82f6',
    x: data.x,
    y: data.y,
  };

  // Move piece to board container if not already there
  if (piece.element.parentElement !== elBoardContainer.value) {
    elBoardContainer.value.appendChild(piece.element);
  }

  // Update piece position
  piece.x = data.x;
  piece.y = data.y;
  updatePiecePosition(piece);

  // Reset rotation to 0 (pieces might have rotation from scrambling)
  piece.element.style.transform = 'rotate(0deg)';

  // Add visual indicator class
  piece.element.classList.add('remote-dragging');
  piece.element.setAttribute('data-remote-user', data.userId);
  piece.element.style.zIndex = 1500; // Below local drag (2000) but above normal (10)
  piece.element.style.position = 'absolute'; // Ensure absolute positioning

  console.log('Remote drag started for piece:', data.pieceId, 'at position:', data.x, data.y);
}

function handleRemoteDragMove(data) {
  const piece = state.pieces.find(p => p.id === data.pieceId);
  if (!piece) {
    console.warn('Remote drag move: piece not found', data.pieceId);
    return;
  }

  // If drag start was missed, initialize it now
  if (!remotePieceDrags[data.pieceId]) {
    console.warn('Remote drag move: drag start was missed, initializing now', data.pieceId);
    remotePieceDrags[data.pieceId] = {
      userId: data.userId,
      userName: data.userName || 'User',
      userColor: data.userColor || '#3b82f6',
      x: data.x,
      y: data.y,
    };
    piece.element.classList.add('remote-dragging');
    piece.element.setAttribute('data-remote-user', data.userId);
    piece.element.style.zIndex = 1500;
    // Reset rotation (pieces might have rotation from scrambling)
    piece.element.style.transform = 'rotate(0deg)';
  }

  // Ensure piece is in board container
  if (piece.element.parentElement !== elBoardContainer.value) {
    elBoardContainer.value.appendChild(piece.element);
  }

  // Update remote drag position
  remotePieceDrags[data.pieceId].x = data.x;
  remotePieceDrags[data.pieceId].y = data.y;

  // Update piece position
  piece.x = data.x;
  piece.y = data.y;
  updatePiecePosition(piece);

  // Ensure position style is set
  piece.element.style.position = 'absolute';
}

function handleRemoteDragEnd(data) {
  const piece = state.pieces.find(p => p.id === data.pieceId);
  if (!piece || !remotePieceDrags[data.pieceId]) return;

  // Update piece position from server
  piece.x = data.x;
  piece.y = data.y;
  updatePiecePosition(piece);

  // Reset transform (keep rotation at 0)
  piece.element.style.transform = 'rotate(0deg)';

  // Remove remote drag indicator
  delete remotePieceDrags[data.pieceId];
  piece.element.classList.remove('remote-dragging');
  piece.element.removeAttribute('data-remote-user');
  piece.element.style.zIndex = 10;

  // Ensure piece remains interactive
  piece.element.style.pointerEvents = 'auto';
}

function handleRemotePieceSnap(data) {
  const piece = state.pieces.find(p => p.id === data.pieceId);
  if (!piece) return;

  // Remove remote drag if exists
  if (remotePieceDrags[data.pieceId]) {
    delete remotePieceDrags[data.pieceId];
    piece.element.classList.remove('remote-dragging');
    piece.element.removeAttribute('data-remote-user');
  }

  // Snap the piece
  piece.snapped = true;
  elPuzzleBoard.value.appendChild(piece.element);
  piece.element.style.left = `${piece.correctX}px`;
  piece.element.style.top = `${piece.correctY}px`;
  piece.element.classList.add('snapped');
  piece.element.style.transform = 'rotate(0deg)';
  state.completedCount++;
  checkWin();
}

// Throttle WebSocket emits for piece drag move
let lastDragEmit = 0;
function emitPieceDragMove(piece, x, y) {
  const now = Date.now();
  if (now - lastDragEmit > CONFIG.websocketThrottle) {
    if (socket.value?.connected) {
      socket.value.emit('puzzle_piece_drag_move', {
        pieceId: piece.id,
        x: x,
        y: y,
        rotation: 0, // Rotation is 0 during dragging
      });
      lastDragEmit = now;
    }
  }
}

/**
 * Game Logic
 */
async function startGame(img) {
  state.originalImage = img;
  imageLoaded.value = true;

  // Don't start if pieces already exist (game already initialized)
  if (state.pieces.length > 0) {
    console.log('Game already initialized, skipping startGame');
    return;
  }

  // Load pending state if we received it before image loaded
  if (pendingServerState.value) {
    loadPuzzleState(pendingServerState.value);
    pendingServerState.value = null;
    return;
  }

  // Request state from server
  if (socket.value && socket.value.connected) {
    socket.value.emit('puzzle_request_state');
  } else {
    console.log('Waiting for socket connection...');
  }
}

function requestPuzzleInitialization(img) {
  console.log('Requesting puzzle initialization from server...');

  // Get the actual computed dimensions from the puzzle board element
  nextTick().then(async () => {
    // Ensure we have valid dimensions - retry if needed
    let boardWidth = 0;
    let boardHeight = 0;
    let retries = 0;
    const maxRetries = 10;

    while ((boardWidth === 0 || boardHeight === 0) && retries < maxRetries) {
      const boardRect = elPuzzleBoard.value.getBoundingClientRect();
      boardWidth = boardRect.width || elPuzzleBoard.value.offsetWidth || elPuzzleBoard.value.clientWidth;
      boardHeight = boardRect.height || elPuzzleBoard.value.offsetHeight || elPuzzleBoard.value.clientHeight;

      if (boardWidth === 0 || boardHeight === 0) {
        await new Promise(resolve => setTimeout(resolve, 50));
        retries++;
      }
    }

    // Fallback to default dimensions if still 0
    if (boardWidth === 0) boardWidth = 1228;
    if (boardHeight === 0) boardHeight = 681;

    const width = Math.max(50, Math.floor(boardWidth));
    const height = Math.max(50, Math.floor(boardHeight));

    // Calculate image dimensions to fit within the board height
    const imgNaturalWidth = img.naturalWidth || img.width || 800;
    const imgNaturalHeight = img.naturalHeight || img.height || 600;
    const imgRatio = imgNaturalWidth / imgNaturalHeight;

    let imageHeight = height;
    let imageWidth = height * imgRatio;

    if (imageWidth > width) {
      const scaleFactor = width / imageWidth;
      imageWidth = width;
      imageHeight = imageHeight * scaleFactor;
    }

    const imageX = (width - imageWidth) / 2;
    const imageY = (height - imageHeight) / 2;

    // Calculate grid size based on image dimensions
    const sizeVal = PUZZLE_SETTINGS.gridSize;
    let targetRows = 10;
    let targetCols = 12;
    if (sizeVal === "large") {
      targetRows = 5;
      targetCols = 6;
    } else if (sizeVal === "medium") {
      targetRows = 8;
      targetCols = 10;
    } else if (sizeVal === "small") {
      targetRows = 10;
      targetCols = 12;
    }

    // Request initialization from server
    if (socket.value?.connected) {
      socket.value.emit('puzzle_init_request', {
        width,
        height,
        imageWidth,
        imageHeight,
        imageX,
        imageY,
        rows: targetRows,
        cols: targetCols,
        rotationRange: PUZZLE_SETTINGS.rotationRange,
      });
    }
  });
}

function loadPuzzleState(serverState) {
  console.log('Loading puzzle state from server...', serverState.pieces.length, 'pieces');

  // Restore dimensions
  if (serverState.imageParams) {
    state.width = serverState.imageParams.width;
    state.height = serverState.imageParams.height;
    state.imageWidth = serverState.imageParams.imageWidth;
    state.imageHeight = serverState.imageParams.imageHeight;
    state.imageX = serverState.imageParams.imageX;
    state.imageY = serverState.imageParams.imageY;
    state.rows = serverState.imageParams.rows;
    state.cols = serverState.imageParams.cols;
    state.pieceWidth = serverState.imageParams.pieceWidth;
    state.pieceHeight = serverState.imageParams.pieceHeight;
  }

  updateGuide();

  // Clear any existing pieces
  elPuzzleBoard.value.innerHTML = "";
  elLeftSidebar.value.innerHTML = "";
  elRightSidebar.value.innerHTML = "";
  state.pieces = [];
  state.completedCount = 0;

  // Reconstruct pieces from server state
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = state.width;
  canvas.height = state.height;
  ctx.drawImage(state.originalImage, state.imageX, state.imageY, state.imageWidth, state.imageHeight);

  serverState.pieces.forEach(pData => {
    // Recreate piece using stored shape and data from server
    createPiece(pData.col, pData.row, pData.shape, canvas, pData);
  });

  // Update completion status
  state.completedCount = state.pieces.filter(p => p.snapped).length;
  if (serverState.isCompleted || state.completedCount === state.pieces.length) {
    isWin.value = true;
  }
}

// generatePieces removed - puzzle generation is now done on the backend

function createPiece(col, row, shape, fullImageCanvas, existingData = null) {
  const piece = document.createElement("canvas");
  const pCtx = piece.getContext("2d");

  const padW = state.pieceWidth * 0.35;
  const padH = state.pieceHeight * 0.35;

  const pieceTotalWidth = state.pieceWidth + padW * 2;
  const pieceTotalHeight = state.pieceHeight + padH * 2;

  piece.width = Math.max(1, Math.ceil(pieceTotalWidth));
  piece.height = Math.max(1, Math.ceil(pieceTotalHeight));

  pCtx.save();
  pCtx.translate(padW, padH);

  drawPuzzlePath(pCtx, state.pieceWidth, state.pieceHeight, shape);

  pCtx.clip();

  // Calculate source position relative to the image area on the canvas
  // Piece position relative to image origin
  const pieceXInImage = col * state.pieceWidth;
  const pieceYInImage = row * state.pieceHeight;

  // Source position on the full canvas (accounting for image position)
  const srcX = state.imageX + pieceXInImage - padW;
  const srcY = state.imageY + pieceYInImage - padH;

  pCtx.drawImage(
    fullImageCanvas,
    srcX,
    srcY,
    pieceTotalWidth,
    pieceTotalHeight,
    -padW,
    -padH,
    pieceTotalWidth,
    pieceTotalHeight
  );

  pCtx.strokeStyle = "rgba(0,0,0,0.4)";
  pCtx.lineWidth = 1;
  pCtx.stroke();

  pCtx.strokeStyle = "rgba(255,255,255,0.3)";
  pCtx.lineWidth = 1;
  pCtx.stroke();

  pCtx.restore();

  const wrapper = document.createElement("div");
  wrapper.className = "puzzle-piece";
  wrapper.style.width = `${pieceTotalWidth}px`;
  wrapper.style.height = `${pieceTotalHeight}px`;
  wrapper.appendChild(piece);

  // Correct position is relative to the image area on the board
  const pieceData = {
    id: `p_${col}_${row}`,
    col: col,
    row: row,
    shape: shape, // Store shape
    x: 0,
    y: 0,
    correctX: state.imageX + pieceXInImage - padW,
    correctY: state.imageY + pieceYInImage - padH,
    element: wrapper,
    snapped: false,
    padW: padW,
    padH: padH,
  };

  if (existingData) {
    // Restore from server state
    pieceData.snapped = existingData.snapped;

    // Place in correct container and set position
    if (existingData.snapped) {
      // Snapped pieces go in elPuzzleBoard and use correctX/correctY
      pieceData.x = pieceData.correctX;
      pieceData.y = pieceData.correctY;
      elPuzzleBoard.value.appendChild(wrapper);
      wrapper.style.left = `${pieceData.correctX}px`;
      wrapper.style.top = `${pieceData.correctY}px`;
      wrapper.classList.add("snapped");
      wrapper.style.zIndex = "1";
    } else {
      // Non-snapped pieces go in sidebars or board container
      pieceData.x = existingData.x;
      pieceData.y = existingData.y;
      let container = elBoardContainer.value;
      if (existingData.container === 'left') container = elLeftSidebar.value;
      if (existingData.container === 'right') container = elRightSidebar.value;

      container.appendChild(wrapper);
      wrapper.style.left = `${existingData.x}px`;
      wrapper.style.top = `${existingData.y}px`;
      wrapper.style.zIndex = "10";
    }

    wrapper.style.transform = `rotate(${existingData.rotation}deg)`;
    wrapper.style.pointerEvents = "auto";
    wrapper.style.position = "absolute";
  } else {
    // This should not happen - all pieces should come from server state with existingData
    console.warn('Creating piece without existingData - this should not happen');
  }

  // Bring piece to front on hover to make stacked pieces accessible
  wrapper.addEventListener("mouseenter", () => {
    if (!pieceData.snapped && !state.isDragging && !remotePieceDrags[pieceData.id]) {
      wrapper.style.zIndex = "100";
    }
  });

  wrapper.addEventListener("mouseleave", () => {
    if (!pieceData.snapped && !state.isDragging && state.draggedPiece?.id !== pieceData.id && !remotePieceDrags[pieceData.id]) {
      wrapper.style.zIndex = "10";
    }
  });

  wrapper.addEventListener("mousedown", (e) => onDragStart(e, pieceData));
  wrapper.addEventListener("touchstart", (e) => onDragStart(e, pieceData), {
    passive: false,
  });

  state.pieces.push(pieceData);
}

function drawPuzzlePath(ctx, w, h, shape) {
  ctx.beginPath();
  const sz = Math.min(w, h);
  const neck = sz * 0.15;
  const tab = sz * 0.25;

  // Top
  ctx.moveTo(0, 0);
  if (shape.top !== 0) {
    const s = shape.top;
    ctx.lineTo(w / 2 - neck, 0);
    ctx.bezierCurveTo(
      w / 2 - neck,
      -tab * s,
      w / 2 + neck,
      -tab * s,
      w / 2 + neck,
      0
    );
  }
  ctx.lineTo(w, 0);

  // Right
  if (shape.right !== 0) {
    const s = shape.right;
    ctx.lineTo(w, h / 2 - neck);
    ctx.bezierCurveTo(
      w + tab * s,
      h / 2 - neck,
      w + tab * s,
      h / 2 + neck,
      w,
      h / 2 + neck
    );
  }
  ctx.lineTo(w, h);

  // Bottom
  if (shape.bottom !== 0) {
    const s = shape.bottom;
    ctx.lineTo(w / 2 + neck, h);
    ctx.bezierCurveTo(
      w / 2 + neck,
      h + tab * s,
      w / 2 - neck,
      h + tab * s,
      w / 2 - neck,
      h
    );
  }
  ctx.lineTo(0, h);

  // Left
  if (shape.left !== 0) {
    const s = shape.left;
    ctx.lineTo(0, h / 2 + neck);
    ctx.bezierCurveTo(
      -tab * s,
      h / 2 + neck,
      -tab * s,
      h / 2 - neck,
      0,
      h / 2 - neck
    );
  }
  ctx.lineTo(0, 0);
  ctx.closePath();
}

// scramblePieces removed - puzzle scrambling is now done on the backend

function onDragStart(e, piece) {
  if (piece.snapped) return;
  // Don't allow dragging if another user is already dragging this piece
  if (remotePieceDrags[piece.id]) return;

  e.preventDefault();

  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;

  state.isDragging = true;
  state.draggedPiece = piece;

  const rect = piece.element.getBoundingClientRect();
  const containerRect = elBoardContainer.value.getBoundingClientRect();

  state.dragOffsetX = clientX - rect.left;
  state.dragOffsetY = clientY - rect.top;

  if (piece.element.parentElement !== elBoardContainer.value) {
    elBoardContainer.value.appendChild(piece.element);
    piece.x = rect.left - containerRect.left;
    piece.y = rect.top - containerRect.top;
    updatePiecePosition(piece);
  } else {
    piece.x = rect.left - containerRect.left;
    piece.y = rect.top - containerRect.top;
  }

  piece.element.style.zIndex = 2000;
  piece.element.style.transform = "scale(1.1) rotate(0deg)";

  // Emit drag start event to WebSocket
  if (socket.value?.connected) {
    socket.value.emit('puzzle_piece_drag_start', {
      pieceId: piece.id,
      x: piece.x,
      y: piece.y,
      rotation: 0, // Rotation is reset to 0 when dragging starts
    });
  }
}

function onDragMove(e) {
  if (!state.isDragging || !state.draggedPiece) return;
  // Prevent scrolling while dragging on touch
  if (e.type === "touchmove") e.preventDefault();

  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;

  const containerRect = elBoardContainer.value.getBoundingClientRect();

  const newX = clientX - containerRect.left - state.dragOffsetX;
  const newY = clientY - containerRect.top - state.dragOffsetY;

  state.draggedPiece.x = newX;
  state.draggedPiece.y = newY;

  updatePiecePosition(state.draggedPiece);

  // Emit drag move event to WebSocket (throttled)
  emitPieceDragMove(state.draggedPiece, newX, newY);
}

function onDragEnd() {
  if (!state.isDragging || !state.draggedPiece) return;

  const piece = state.draggedPiece;
  state.isDragging = false;
  state.draggedPiece = null;

  piece.element.style.transform = "rotate(0deg)";
  piece.element.style.zIndex = 10;

  // Emit drag end event to WebSocket
  if (socket.value?.connected) {
    socket.value.emit('puzzle_piece_drag_end', {
      pieceId: piece.id,
      x: piece.x,
      y: piece.y,
      rotation: 0, // Rotation is 0 when drag ends
    });
  }

  checkSnap(piece);
}

function updatePiecePosition(piece) {
  piece.element.style.left = `${piece.x}px`;
  piece.element.style.top = `${piece.y}px`;
}

function checkSnap(piece) {
  const boardRect = elPuzzleBoard.value.getBoundingClientRect();
  const containerRect = elBoardContainer.value.getBoundingClientRect();

  const boardOffsetX = boardRect.left - containerRect.left;
  const boardOffsetY = boardRect.top - containerRect.top;

  const targetX = boardOffsetX + piece.correctX;
  const targetY = boardOffsetY + piece.correctY;

  const dx = piece.x - targetX;
  const dy = piece.y - targetY;
  const distance = Math.sqrt(dx * dx + dy * dy);

  if (distance < CONFIG.snapDistance) {
    snapPiece(piece);
  }
}

function snapPiece(piece) {
  piece.snapped = true;
  elPuzzleBoard.value.appendChild(piece.element);
  piece.element.style.left = `${piece.correctX}px`;
  piece.element.style.top = `${piece.correctY}px`;
  piece.element.classList.add("snapped");

  piece.element.animate(
    [{ transform: "scale(1.1)" }, { transform: "scale(1)" }],
    { duration: 200 }
  );

  state.completedCount++;

  // Emit snap event to WebSocket
  if (socket.value?.connected) {
    socket.value.emit('puzzle_piece_snap', {
      pieceId: piece.id,
    });
  }

  checkWin();
}

function checkWin() {
  if (state.completedCount === state.pieces.length) {
    setTimeout(() => {
      isWin.value = true;
    }, 300);
  }
}

function updateGuide() {
  if (PUZZLE_SETTINGS.guideVisible && state.originalImage && state.imageWidth > 0) {
    // Use the calculated image dimensions to match the canvas rendering
    const bgSize = `${state.imageWidth}px ${state.imageHeight}px`;
    const bgX = state.imageX;
    const bgY = state.imageY;
    const bgPosition = `${bgX}px ${bgY}px`;

    elPuzzleBoard.value.style.background = `
      linear-gradient(rgba(0,0,0,0.60), rgba(0,0,0,0.60)),
      url(${state.originalImage.src})
    `;
    elPuzzleBoard.value.style.backgroundSize = bgSize;
    elPuzzleBoard.value.style.backgroundPosition = bgPosition;
    elPuzzleBoard.value.style.backgroundRepeat = "no-repeat";
  } else {
    elPuzzleBoard.value.style.background = "rgba(255, 255, 255, 0.05)";
  }
}

function restartGame() {
  // Request reset from server
  if (socket.value?.connected) {
    socket.value.emit('puzzle_reset_request');
  }
}

onMounted(() => {
  // Initialize WebSocket connection
  initWebSocket();

  // Removed localStorage restore - fully rely on server state

  if (PUZZLE_SETTINGS.defaultImageUrl) {
    const img = new Image();
    img.crossOrigin = "Anonymous";
    img.src = PUZZLE_SETTINGS.defaultImageUrl;
    img.onload = () => startGame(img);
  }

  window.addEventListener("mousemove", onDragMove);
  window.addEventListener("mouseup", onDragEnd);
  window.addEventListener("touchmove", onDragMove, { passive: false });
  window.addEventListener("touchend", onDragEnd);
});

onUnmounted(() => {
  window.removeEventListener("mousemove", onDragMove);
  window.removeEventListener("mouseup", onDragEnd);
  window.removeEventListener("touchmove", onDragMove);
  window.removeEventListener("touchend", onDragEnd);

  // Disconnect WebSocket
  if (socket.value) {
    socket.value.disconnect();
    socket.value = null;
  }
});
</script>

<template>
  <footer class="w-full h-screen relative bg-black text-white overflow-hidden">
    <div ref="elGameContainer"
      class="puzzle-container w-full h-screen flex lg:flex-row flex-col items-center justify-center relative">
      <!-- Left Tray -->
      <div ref="elLeftSidebar" class="left-bar sidebar flex-1 h-full bg-transparent relative z-10"></div>

      <!-- Center Board -->
      <div ref="elBoardContainer" class="board-container relative flex items-center justify-center shrink-0 h-full">
        <div ref="elPuzzleBoard" class="puzzle-board w-[1228rem] h-[681rem] relative"></div>
      </div>

      <!-- Right Tray -->
      <div ref="elRightSidebar" class="right-bar sidebar flex-1 h-full bg-transparent relative z-10"></div>
    </div>

    <!-- Overlay -->
    <div v-if="isWin"
      class="overlay fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/80 text-white">
      <h2 class="text-[48rem] font-new-spirit mb-4">Puzzle Completed!</h2>
      <p class="text-[24rem] font-poppins mb-8">Great job.</p>
      <button @click="restartGame"
        class="px-8 py-4 bg-white text-black rounded-full font-bold hover:bg-gray-200 transition-colors">
        Play Again
      </button>
    </div>

    <div
      class="contact absolute bottom-[57rem] left-1/2 -translate-x-1/2 z-20 flex flex-col gap-6 items-center justify-center pointer-events-none">
      <a href="mailto:support@allthingswtf.com"
        class="text-white text-[36rem] leading-none font-new-spirit pointer-events-auto">support@allthingswtf.com</a>

      <p class="flex flex-col items-center text-center font-poppins leading-none gap-[3rem]">
        <span class="text-[12rem]"> Copyright 2026 by All Things WTF </span>
        <span class="text-[12rem] block">
          Design & Development by Visual Identity Studio.
        </span>
      </p>
    </div>
  </footer>
</template>

<style scoped>
:deep(.puzzle-piece) {
  position: absolute;
  cursor: grab;
  user-select: none;
  touch-action: none;
  filter: drop-shadow(0 4rem 8rem rgba(0, 0, 0, 0.3));
  transition: transform 0.2s ease-out;
}

:deep(.puzzle-piece:active) {
  cursor: grabbing;
}

:deep(.puzzle-piece.snapped) {
  cursor: default !important;
  filter: none !important;
  pointer-events: none !important;
}

:deep(.puzzle-piece.remote-dragging) {
  opacity: 0.8;
  border: 2px solid rgba(59, 130, 246, 0.5);
  box-shadow: 0 0 10px rgba(59, 130, 246, 0.3);
}

.sidebar {
  position: relative;
  overflow: visible;
}

.board-container {
  overflow: visible;
}

.puzzle-board {
  /* Ensure pieces snapped to board are visible */
  overflow: visible;
}
</style>
