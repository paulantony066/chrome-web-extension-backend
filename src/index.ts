import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import fs from 'fs'
import path from 'path'

const app = express()
app.use(cors())

const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
})

interface Problem {
  titleSlug: string
  difficulty: 'Easy' | 'Medium' | 'Hard'
}

let problemPool: Problem[] = []
try {
  const filePath = path.join(__dirname, 'problems.json')
  const fileData = fs.readFileSync(filePath, 'utf-8')
  problemPool = JSON.parse(fileData)
  console.log(`✅ Loaded ${problemPool.length} problems from local JSON!`)
} catch (error) {
  console.error('Failed to load problems.json, using fallback:', error)
  problemPool = [
    { titleSlug: "two-sum", difficulty: "Easy" },
    { titleSlug: "valid-parentheses", difficulty: "Easy" }
  ]
}

let waitingUser: { id: string; username: string } | null = {} as any

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`)

  socket.on('find_match', (data?: { username?: string }) => {
    const username = data?.username || 'AnonymousCoder'

    if (!waitingUser || !waitingUser.id) {
      waitingUser = { id: socket.id, username }
      socket.emit('match_status', { message: 'Searching for an opponent...' })
    } else if (waitingUser.id === socket.id) {
      return
    } else {
      const roomId = `room_${Date.now()}`
      const opponent = waitingUser
      waitingUser = null 

      socket.join(roomId)
      const opponentSocket = io.sockets.sockets.get(opponent.id)
      
      if (opponentSocket) {
        opponentSocket.join(roomId)
      }

      io.to(socket.id).emit('match_found', { roomId, opponentUsername: opponent.username })
      if (opponentSocket) {
        io.to(opponent.id).emit('match_found', { roomId, opponentUsername: username })
      }

      console.log(`Match created! Room: ${roomId} connecting ${opponent.username} and ${username}`)
    }
  })

  socket.on('rejoin_room', (data: { roomId: string }) => {
    socket.join(data.roomId)
    console.log(`User ${socket.id} re-joined active room: ${data.roomId}`)
  })

  socket.on('disconnect', () => {
    if (waitingUser?.id === socket.id) {
      waitingUser = null
    }
    console.log(`User disconnected: ${socket.id}`)
  })

  socket.on('typing', () => {
    const rooms = Array.from(socket.rooms)
    const duelRoom = rooms.find(r => r !== socket.id)
    if (duelRoom) socket.to(duelRoom).emit('opponent_typing')
  })

  socket.on('stop_typing', () => {
    const rooms = Array.from(socket.rooms)
    const duelRoom = rooms.find(r => r !== socket.id)
    if (duelRoom) socket.to(duelRoom).emit('opponent_stop_typing')
  })

  socket.on('run_tests', () => {
    const rooms = Array.from(socket.rooms)
    const duelRoom = rooms.find(r => r !== socket.id)
    if (duelRoom) socket.to(duelRoom).emit('opponent_running_tests')
  })

  socket.on('test_result', (result: { passed: boolean }) => {
    const rooms = Array.from(socket.rooms)
    const duelRoom = rooms.find(r => r !== socket.id)
    if (duelRoom) {
      socket.to(duelRoom).emit('opponent_test_result', result)
    }
  })

  socket.on('solution_accepted', () => {
    const rooms = Array.from(socket.rooms)
    const duelRoom = rooms.find(r => r !== socket.id)
    if (duelRoom) {
      socket.to(duelRoom).emit('opponent_accepted')
    }
  })

  socket.on('choose_problem', (data?: { difficulty?: string }) => {
    const rooms = Array.from(socket.rooms)
    const duelRoom = rooms.find(r => r !== socket.id)
    
    if (duelRoom) {
      let filteredPool = problemPool

      if (data?.difficulty && data.difficulty !== 'All') {
        filteredPool = problemPool.filter(p => p.difficulty.toLowerCase() === data.difficulty?.toLowerCase())
      }

      if (filteredPool.length === 0) filteredPool = problemPool

      const randomProblem = filteredPool[Math.floor(Math.random() * filteredPool.length)]
      io.to(duelRoom).emit('problem_chosen', { 
        problemSlug: randomProblem.titleSlug, 
        difficulty: randomProblem.difficulty 
      })
    }
  })

  // --- Simple Chat Handler ---
// --- Simple Chat Handler ---
  socket.on('send_message', (data: { message: string }) => {
    const rooms = Array.from(socket.rooms)
    const duelRoom = rooms.find(r => r !== socket.id)
    if (duelRoom) {
      socket.to(duelRoom).emit('receive_message', { message: data.message })
    }
  })
})

const PORT = 3000
httpServer.listen(PORT, () => {
  console.log(`🚀 Local backend running at http://localhost:${PORT}`)
})