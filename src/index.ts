import express from 'express'
import { createServer } from 'http'
import { Server, Socket } from 'socket.io'
import cors from 'cors'
import fs from 'fs'
import path from 'path'

const app = express()
app.use(cors())

app.get('/', (_req, res) => {
  res.send('LC Duel server is running')
})

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

let waitingUser: { id: string; username: string } | null = null

const endedRooms = new Set<string>()


interface PendingRoom {
  roomId: string
  hostSocketId: string
  hostPlayerId: string
  hostUsername: string
}
const pendingRooms = new Map<string, PendingRoom>()


const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

const generateCode = (): string => {
  let code = ''
  do {
    code = Array.from({ length: 5 }, () =>
      CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
    ).join('')
  } while (
    pendingRooms.has(code) ||
    io.sockets.adapter.rooms.has(`room_${code}`) ||
    endedRooms.has(`room_${code}`)
  )
  return code
}


const cancelHostedRoom = (socket: Socket): boolean => {
  for (const [code, room] of pendingRooms) {
    if (room.hostSocketId === socket.id) {
      pendingRooms.delete(code)
      socket.leave(room.roomId)
      return true
    }
  }
  return false
}


const getDuelRoom = (socket: Socket): string | undefined =>
  Array.from(socket.rooms).find(r => r !== socket.id)

const relay = (socket: Socket, event: string, payload?: unknown) => {
  const room = getDuelRoom(socket)
  if (!room) return
  const members = io.sockets.adapter.rooms.get(room)
  if (!members) return
  for (const id of members) {
    const s = io.sockets.sockets.get(id)
    if (s && s.data.playerId !== socket.data.playerId) {
      s.emit(event, payload)
    }
  }
}


io.use((socket, next) => {
  socket.data.playerId = socket.handshake.auth?.playerId ?? socket.id
  console.log(`connect: socket=${socket.id} player=${socket.data.playerId}`)
  next()
})

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`)


  socket.on('find_match', (data?: { username?: string }) => {
    const username = data?.username || 'AnonymousCoder'

    if (getDuelRoom(socket)) return  
    cancelHostedRoom(socket)          

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


  socket.on('host_room', (data?: { username?: string }) => {
    if (getDuelRoom(socket)) {
      socket.emit('room_error', { message: 'You are already in a battle.' })
      return
    }

    if (waitingUser?.id === socket.id) waitingUser = null
    cancelHostedRoom(socket)

    const code = generateCode()
    const roomId = `room_${code}`

    pendingRooms.set(code, {
      roomId,
      hostSocketId: socket.id,
      hostPlayerId: socket.data.playerId,
      hostUsername: data?.username || 'AnonymousCoder',
    })
    socket.join(roomId)   

    socket.emit('room_created', { code })
    console.log(`Room hosted: ${code} by ${socket.id}`)
  })


  socket.on('join_room', (data?: { code?: string; username?: string }) => {
    const code = (data?.code ?? '').trim().toUpperCase()
    const username = data?.username || 'AnonymousCoder'

    if (getDuelRoom(socket)) {
      socket.emit('room_error', { message: 'You are already in a battle.' })
      return
    }

    const room = pendingRooms.get(code)
    if (!room) {
      socket.emit('room_error', { message: 'Room not found or already full.' })
      return
    }
    if (room.hostPlayerId === socket.data.playerId) {
      socket.emit('room_error', { message: "You can't join your own room." })
      return
    }

    const hostSocket = io.sockets.sockets.get(room.hostSocketId)
    if (!hostSocket) {
      pendingRooms.delete(code)
      socket.emit('room_error', { message: 'The host has left.' })
      return
    }

  
    pendingRooms.delete(code)
    if (waitingUser?.id === socket.id) waitingUser = null
    cancelHostedRoom(socket)   

    socket.join(room.roomId)

  
    io.to(socket.id).emit('match_found', { roomId: room.roomId, opponentUsername: room.hostUsername })
    io.to(room.hostSocketId).emit('match_found', { roomId: room.roomId, opponentUsername: username })

    console.log(`Custom match started: ${room.roomId} (${room.hostUsername} vs ${username})`)
  })


  socket.on('cancel_room', () => {
    if (cancelHostedRoom(socket)) socket.emit('room_cancelled')
  })

  socket.on('rejoin_room', (data: { roomId: string }) => {
    if (endedRooms.has(data.roomId)) {
      socket.emit('battle_ended')
      return
    }

    const members = io.sockets.adapter.rooms.get(data.roomId)
    if (members) {
      for (const id of Array.from(members)) {
        const s = io.sockets.sockets.get(id)
        if (s && s.id !== socket.id && s.data.playerId === socket.data.playerId) {
          s.disconnect(true)
        }
      }
    }

    socket.join(data.roomId)
    console.log(`User ${socket.id} re-joined active room: ${data.roomId}`)
    console.log(`room ${data.roomId} members:`, io.sockets.adapter.rooms.get(data.roomId)?.size)
  })

  socket.on('end_battle', () => {
    const duelRoom = getDuelRoom(socket)
    if (!duelRoom) return

    endedRooms.add(duelRoom)
    relay(socket, 'battle_ended')
    io.in(duelRoom).socketsLeave(duelRoom)
    console.log(`Battle ended, room closed: ${duelRoom}`)
  })

  socket.on('disconnect', () => {
    if (waitingUser?.id === socket.id) {
      waitingUser = null
    }
    cancelHostedRoom(socket)   
    console.log(`User disconnected: ${socket.id}`)
  })

  socket.on('typing',            () => relay(socket, 'opponent_typing'))
  socket.on('stop_typing',       () => relay(socket, 'opponent_stop_typing'))
  socket.on('run_tests',         () => relay(socket, 'opponent_running_tests'))
  socket.on('test_result',       (r: { passed: boolean }) => relay(socket, 'opponent_test_result', r))
  socket.on('solution_accepted', () => relay(socket, 'opponent_accepted'))
  socket.on('send_message',      (d: { message: string }) =>
    relay(socket, 'receive_message', { message: d.message })
  )

  socket.on('choose_problem', (data?: { difficulty?: string }) => {
    const duelRoom = getDuelRoom(socket)

    if (duelRoom) {
      let filteredPool = problemPool

      if (data?.difficulty && data.difficulty !== 'All') {
        filteredPool = problemPool.filter(
          p => p.difficulty.toLowerCase() === data.difficulty?.toLowerCase()
        )
      }

      if (filteredPool.length === 0) filteredPool = problemPool

      const randomProblem = filteredPool[Math.floor(Math.random() * filteredPool.length)]
      io.to(duelRoom).emit('problem_chosen', {
        problemSlug: randomProblem.titleSlug,
        difficulty: randomProblem.difficulty
      })
    }
  })
})

const PORT = Number(process.env.PORT) || 3000
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend running on port ${PORT}`)
})