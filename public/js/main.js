// WebSocket 连接
const socket = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");

// 全局状态
let currentUser = JSON.parse(localStorage.getItem("chat_user")) || null;
let currentRoom = "公共聊天";
let friends = [];

// DOM 元素
const authScreen = document.getElementById("authScreen");
const chatScreen = document.getElementById("chatScreen");
const adminPanel = document.getElementById("adminPanel");
const messagesDiv = document.getElementById("messages");
const messageInput = document.getElementById("messageInput");
const roomList = document.getElementById("roomList");
const userList = document.getElementById("userList");
const friendList = document.getElementById("friendList");
const currentRoomTitle = document.getElementById("currentRoomTitle");

// 房间预设
const rooms = ["公共聊天", "技术交流", "游戏专区", "随便聊聊"];

// --- 初始化 UI ---
function initRooms() {
  roomList.innerHTML = rooms.map(r => 
    `<div class="room-item ${r === currentRoom ? 'active' : ''}" data-room="${r}">${r}</div>`
  ).join("");
  
  roomList.querySelectorAll('.room-item').forEach(el => {
    el.addEventListener('click', () => {
      currentRoom = el.dataset.room;
      currentRoomTitle.textContent = currentRoom;
      initRooms();
      messagesDiv.innerHTML = ""; // 切换房间清空UI
    });
  });
}

// 检查登录状态，恢复 UI
function checkLoginState() {
  if (currentUser) {
    authScreen.style.display = "none";
    chatScreen.style.display = "flex";
    initRooms();
  } else {
    authScreen.style.display = "flex";
    chatScreen.style.display = "none";
  }
}
checkLoginState();

// --- WebSocket 发送封装 ---
function send(data) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
  }
}

// --- 登录 / 注册 UI 切换逻辑 ---
document.querySelectorAll('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`${tab.dataset.tab}Form`).classList.add('active');
  });
});

document.getElementById("loginForm").addEventListener("submit", (e) => {
  e.preventDefault();
  send({ type: "login", username: document.getElementById("loginUsername").value.trim(), password: document.getElementById("loginPassword").value });
});

document.getElementById("registerForm").addEventListener("submit", (e) => {
  e.preventDefault();
  send({ type: "register", username: document.getElementById("registerUsername").value.trim(), password: document.getElementById("registerPassword").value, email: document.getElementById("registerEmail").value.trim() });
});

// --- 聊天发送逻辑 ---
function sendMessage() {
  const text = messageInput.value.trim();
  if (!text) return;
  send({ type: "message", room: currentRoom, text });
  messageInput.value = "";
}

document.getElementById("sendBtn").addEventListener("click", sendMessage);
messageInput.addEventListener("keypress", (e) => { if (e.key === 'Enter') sendMessage(); });

// --- WebSocket 核心接收逻辑 ---
socket.onmessage = (e) => {
  const data = JSON.parse(e.data);

  // 1. 历史消息加载 (持久化恢复)
  if (data.type === "history") {
    data.messages.forEach(msg => {
      if (msg.room === currentRoom) {
        const div = document.createElement("div");
        div.className = `message ${msg.username === currentUser?.username ? 'own' : ''}`;
        div.innerHTML = `<strong>${msg.username}</strong>: ${msg.text}`;
        messagesDiv.appendChild(div);
      }
    });
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    return;
  }

  // 2. 登录成功 (持久化状态)
  if (data.type === "login_success") {
    currentUser = data.user;
    localStorage.setItem("chat_user", JSON.stringify(currentUser));
    checkLoginState();
    return;
  }

  // 3. 登录/注册 失败提示
  if (data.type === "login_error" || data.type === "register_error") {
    alert(data.message);
    return;
  }
  if (data.type === "register_success") {
    alert("注册成功，请登录！");
    document.querySelector('[data-tab="login"]').click();
    return;
  }

  // 4. 接收新消息
  if (data.type === "message") {
    if (data.room === currentRoom) {
      const div = document.createElement("div");
      div.className = `message ${data.username === currentUser?.username ? 'own' : ''}`;
      div.innerHTML = `<strong>${data.username}</strong>: ${data.text}`;
      messagesDiv.appendChild(div);
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }
    return;
  }

  // 5. 在线用户列表
  if (data.type === "users") {
    userList.innerHTML = data.users.map(u => 
      `<div class="user-item">${u.username} ${u.role === 'admin' ? '👑' : ''}</div>`
    ).join("");
    return;
  }

  // 6. 好友系统 (持久化刷新)
  if (data.type === "friend_request_received") {
    document.getElementById("requestText").textContent = `${data.from} 请求添加你为好友，是否同意？`;
    document.getElementById("friendRequestModal").style.display = "flex";
    document.getElementById("friendRequestModal").dataset.fromUser = data.from;
    return;
  }
  if (data.type === "friend_added") {
    friends = data.friends;
    document.getElementById("friendList").innerHTML = friends.length ? 
      friends.map(f => `<div class="friend-item">${f}</div>`).join("") : 
      '<div style="padding:10px 16px; color:#999;">暂无好友</div>';
    return;
  }
};

// --- 好友申请交互逻辑 ---
document.getElementById("addFriendBtn").addEventListener("click", () => {
  document.getElementById("addFriendModal").style.display = "flex";
  document.getElementById("friendNameInput").value = "";
});

document.getElementById("cancelAddFriend").addEventListener("click", () => {
  document.getElementById("addFriendModal").style.display = "none";
});

document.getElementById("confirmAddFriend").addEventListener("click", () => {
  const name = document.getElementById("friendNameInput").value.trim();
  if (name && name !== currentUser?.username) {
    send({ type: "friend_request", to: name });
    document.getElementById("addFriendModal").style.display = "none";
  } else if (name === currentUser?.username) {
    alert("不能添加自己为好友！");
  }
});

document.getElementById("acceptRequest").addEventListener("click", () => {
  const from = document.getElementById("friendRequestModal").dataset.fromUser;
  if (from) {
    send({ type: "friend_accept", from });
    document.getElementById("friendRequestModal").style.display = "none";
  }
});

document.getElementById("rejectRequest").addEventListener("click", () => {
  document.getElementById("friendRequestModal").style.display = "none";
});

// --- 管理员系统 ---
document.getElementById("adminBtn").addEventListener("click", () => {
  if(currentUser?.role !== 'admin') return alert("仅限管理员进入");
  chatScreen.style.display = "none";
  adminPanel.style.display = "block";
  send({ type: "admin_stats" });
  send({ type: "admin_users" });
});

document.getElementById("backToChat").addEventListener("click", () => {
  adminPanel.style.display = "none";
  chatScreen.style.display = "flex";
});

// 全局暴露封禁函数供 HTML 调用
window.adminBan = (name, isBan) => send({ type: isBan ? "admin_unban" : "admin_ban", username: name });
