const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// 静态资源服务
app.use(express.static(path.join(__dirname, 'public')));

// 路由兜底
app.get('/:all', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// 数据持久化目录：优先用环境变量指向可写目录（适配 Render/Railway 等 PaaS）
const DATA_DIR = process.env.DATA_DIR || '/tmp';
const dataFile = path.join(DATA_DIR, 'data.json');
let data = { users: [], messages: [], friends: [] };
if (fs.existsSync(dataFile)) {
  try { data = JSON.parse(fs.readFileSync(dataFile)); } catch (e) { console.error('读取数据文件失败'); }
}

// 如果没有管理员，创建默认管理员
if (!data.users.find(u => u.username === 'admin')) {
  data.users.push({ username: 'admin', password: 'admin123', role: 'admin', banned: false, email: '' });
  try { fs.writeFileSync(dataFile, JSON.stringify(data)); } catch (e) { console.error('写入数据文件失败'); }
}

const clients = [];

// 工具函数
function saveData() { try { fs.writeFileSync(dataFile, JSON.stringify(data)); } catch (e) { console.error('保存失败', e); } }
function broadcast(msg) { clients.forEach(c => c.readyState === 1 && c.send(JSON.stringify(msg))); }
function findUser(name) { return data.users.find(u => u.username === name); }

wss.on('connection', (ws) => {
  let currentUser = null;
  clients.push(ws);

  // 1. 刚连上时，推送历史消息
  ws.send(JSON.stringify({ type: 'history', messages: data.messages }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      // 注册
      case 'register':
        if (findUser(msg.username)) {
          ws.send(JSON.stringify({ type: 'register_error', message: '用户名已存在' }));
          return;
        }
        data.users.push({ username: msg.username, password: msg.password, role: 'user', banned: false, email: msg.email || '' });
        saveData();
        ws.send(JSON.stringify({ type: 'register_success' }));
        break;

      // 登录
      case 'login':
        const u = findUser(msg.username);
        if (!u) { ws.send(JSON.stringify({ type: 'login_error', message: '用户不存在' })); return; }
        if (u.password !== msg.password) { ws.send(JSON.stringify({ type: 'login_error', message: '密码错误' })); return; }
        if (u.banned) { ws.send(JSON.stringify({ type: 'login_error', message: '账号已被封禁' })); return; }

        currentUser = u;
        ws._user = currentUser;
        ws.send(JSON.stringify({ type: 'login_success', user: { username: currentUser.username, role: currentUser.role } }));

        // 2. 登录成功后，广播系统提示 & 更新在线列表
        broadcast({ type: 'system', text: `${currentUser.username} 加入了聊天` });
        broadcast({ type: 'users', users: clients.filter(c => c._user).map(c => c._user) });
        break;

      // 发送消息 (持久化)
      case 'message':
        if (!currentUser) { ws.send(JSON.stringify({ type: 'system', text: '请先登录' })); return; }
        if (currentUser.banned) { ws.send(JSON.stringify({ type: 'system', text: '你已被禁止发言' })); return; }

        const newMsg = { username: currentUser.username, room: msg.room, text: msg.text, time: Date.now() };
        data.messages.push(newMsg);
        if (data.messages.length > 500) data.messages.shift(); // 只保留最近500条
        saveData();
        broadcast({ type: 'message', ...newMsg });
        break;

      // 好友申请
      case 'friend_request':
        if (!currentUser) return;
        const targetUser = findUser(msg.to);
        if (!targetUser) { ws.send(JSON.stringify({ type: 'system', text: '目标用户不存在' })); return; }
        const targetClient = clients.find(c => c._user && c._user.username === msg.to);
        if (targetClient) {
          targetClient.send(JSON.stringify({ type: 'friend_request_received', from: currentUser.username }));
        }
        break;

      // 接受好友 (持久化)
      case 'friend_accept':
        if (!currentUser) return;
        const requesterUser = findUser(msg.from);
        if (requesterUser) {
          data.friends.push({ from: requesterUser.username, to: currentUser.username });
          data.friends.push({ from: currentUser.username, to: requesterUser.username });
          saveData();

          // 3. 接受好友后，给双方推送好友列表
          clients.filter(c => c._user && c._user.username === requesterUser.username).forEach(c =>
            c.send(JSON.stringify({ type: 'friend_added', friends: data.friends.filter(f => f.from === requesterUser.username).map(f => f.to) }))
          );
          ws.send(JSON.stringify({ type: 'friend_added', friends: data.friends.filter(f => f.from === currentUser.username).map(f => f.to) }));
        }
        break;

      case 'friend_reject':
        if (!currentUser) return;
        // 拒绝：给发起方一个反馈
        const rejectTarget = clients.find(c => c._user && c._user.username === msg.from);
        if (rejectTarget) rejectTarget.send(JSON.stringify({ type: 'friend_rejected', by: currentUser.username }));
        break;

      // 管理员功能
      case 'admin_stats':
        if (!currentUser || currentUser.role !== 'admin') return;
        ws.send(JSON.stringify({ type: 'admin_stats', totalUsers: data.users.length, totalMessages: data.messages.length, onlineUsers: clients.length }));
        break;

      case 'admin_users':
        if (!currentUser || currentUser.role !== 'admin') return;
        ws.send(JSON.stringify({ type: 'admin_users', users: data.users }));
        break;

      case 'admin_ban':
        if (!currentUser || currentUser.role !== 'admin') return;
        const banU = findUser(msg.username);
        if (banU) {
          banU.banned = true; saveData();
          // 即时踢掉该用户的在线连接
          clients.filter(c => c._user && c._user.username === msg.username).forEach(c => {
            if (c.readyState === 1) c.send(JSON.stringify({ type: 'system', text: '你的账号已被封禁' }));
            c.close();
          });
        }
        break;
      case 'admin_unban':
        if (!currentUser || currentUser.role !== 'admin') return;
        const unbanU = findUser(msg.username);
        if (unbanU) { unbanU.banned = false; saveData(); }
        break;
    }
  });

  // 断开连接
  ws.on('close', () => {
    if (currentUser) {
      // 4. 离开时广播系统提示 & 更新在线列表
      broadcast({ type: 'system', text: `${currentUser.username} 离开了聊天` });
      broadcast({ type: 'users', users: clients.filter(c => c._user).map(c => c._user) });
    }
    const idx = clients.indexOf(ws);
    if (idx > -1) clients.splice(idx, 1);
  });

  ws.on('error', () => {});
});

// 端口与监听地址：优先用平台注入的环境变量，监听 0.0.0.0 才能被公网访问
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`聪明聊服务启动, port=${PORT}`));
