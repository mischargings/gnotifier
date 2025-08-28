const axios = require('axios');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');


// meow meow meow :3
// cfg = config, 
// api = roblox api, 
// cache = pretty obvious what this is, 
// notifs = messages, 
// tracker = monitoring


class cfg {
  static #cached = null;
  
  static loadConfig() {
    if (this.#cached) return this.#cached;
    
    try {
      const cfgpath = path.join(__dirname, 'config.jsonc');
      const cfgtext = fsSync.readFileSync(cfgpath, 'utf8');
      const cleaned = cfgtext
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      
      this.#cached = JSON.parse(cleaned);
      this.#validateConfig(this.#cached);
      return this.#cached;
    } catch (error) {
      throw new Error(`Failed to load config: ${error.message}`);
    }
  }
  
  static #validateConfig(cfg) {
    const req = ['token', 'discordid', 'robloxcookie', 'usersToWatch', 'names'];
    const missing = req.filter(key => !cfg[key]);
    if (missing.length > 0) {
      throw new Error(`Missing required config keys: ${missing.join(', ')}`);
    }
  }
}

class api {
  constructor(cookie) {
    this.cookie = cookie;
    this.limiter = new Map();
    this.retries = 3;
    this.delay = 1000;
  }

  async #req(url, opts = {}, tries = this.retries) {
    const hdrs = {
      Cookie: `.ROBLOSECURITY=${this.cookie}`,
      'Content-Type': 'application/json',
      ...opts.headers
    };

    for (let i = 0; i < tries; i++) {
      try {
        const resp = await axios({
          url,
          headers: hdrs,
          timeout: 10000,
          ...opts
        });
        return resp.data;
      } catch (error) {
        if (i === tries - 1) throw error;
        
        const wait = this.delay * Math.pow(2, i);
        await new Promise(resolve => setTimeout(resolve, wait));
      }
    }
  }

  async getUserStatus(uid) {
    return this.#req('https://presence.roblox.com/v1/presence/users', {
      method: 'post',
      data: { userIds: [uid] }
    }).then(resp => resp?.userPresences?.[0] || null);
  }

  async getGameInfo(pid) {
    return this.#req('https://games.roblox.com/v1/games/multiget-place-details', {
      method: 'get',
      params: { placeIds: pid }
    }).then(resp => resp?.[0] || null);
  }

  async getUserFriends(uid) {
    const friends = [];
    let cursor = '';
    let more = true;

    while (more) {
      const resp = await this.#req(
        `https://friends.roblox.com/v1/users/${uid}/friends/find`,
        {
          method: 'get',
          params: { limit: 50, cursor, userSort: '' }
        }
      );

      if (resp?.PageItems) {
        friends.push(...resp.PageItems.map(f => f.id.toString()));
        cursor = resp.NextCursor || '';
        more = !!resp.NextCursor;
      } else {
        more = false;
      }
    }
    return friends;
  }

  async getUserFollowing(uid) {
    const following = [];
    let cursor = '';
    let more = true;

    while (more) {
      const resp = await this.#req(
        `https://friends.roblox.com/v1/users/${uid}/followings`,
        {
          method: 'get',
          params: { limit: 50, cursor, sortOrder: 'Asc' }
        }
      );

      if (resp?.data) {
        following.push(...resp.data.map(f => f.id.toString()));
        cursor = resp.nextPageCursor || '';
        more = !!resp.nextPageCursor;
      } else {
        more = false;
      }
    }
    return following;
  }

  async getUsername(uid) {
    return this.#req('https://apis.roblox.com/user-profile-api/v1/user/profiles/get-profiles', {
      method: 'post',
      data: { fields: ["names.username"], userIds: [uid] },
      headers: { 'accept': 'application/json' }
    }).then(resp => resp?.profileDetails?.[0]?.names?.username || 'Unknown');
  }
}

const config = cfg.loadConfig();
const { token, discordid, robloxcookie, usersToWatch, names } = config;
const rblx = new api(robloxcookie);

class cache {
  constructor(dir) {
    this.dir = dir;
    this.statusf = path.join(dir, 'lastStatus.json');
    this.friendsf = path.join(dir, 'friends.json');
    this.followf = path.join(dir, 'following.json');
    
    this.status = {};
    this.friends = {};
    this.following = {};
    
    this.#ensureDir();
  }

  #ensureDir() {
    if (!fsSync.existsSync(this.dir)) {
      fsSync.mkdirSync(this.dir, { recursive: true });
    }
  }

  async #load(file, def = {}) {
    try {
      if (fsSync.existsSync(file)) {
        const content = await fs.readFile(file, 'utf8');
        return JSON.parse(content);
      }
    } catch (error) {
      console.error(`Error loading ${path.basename(file)}:`, error.message);
    }
    return def;
  }

  async #save(file, data) {
    try {
      await fs.writeFile(file, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error(`Error saving ${path.basename(file)}:`, error.message);
    }
  }

  async loadAll() {
    [this.status, this.friends, this.following] = await Promise.all([
      this.#load(this.statusf),
      this.#load(this.friendsf),
      this.#load(this.followf)
    ]);
  }

  async saveStatus() {
    await this.#save(this.statusf, this.status);
  }

  async saveFriends() {
    await this.#save(this.friendsf, this.friends);
  }

  async saveFollowing() {
    await this.#save(this.followf, this.following);
  }

  getStatus(uid) {
    return this.status[uid] || {};
  }

  setStatus(uid, st) {
    this.status[uid] = st;
  }

  getFriends(uid) {
    return this.friends[uid] || [];
  }

  setFriends(uid, f) {
    this.friends[uid] = f;
  }

  getFollowing(uid) {
    return this.following[uid] || [];
  }

  setFollowing(uid, f) {
    this.following[uid] = f;
  }
}

const storage = new cache(path.join(__dirname, 'cache'));

class notifs {
  constructor(bot, target) {
    this.bot = bot;
    this.target = target;
  }

  async #dm(embed) {
    try {
      const user = await this.bot.users.fetch(this.target);
      await user.send({ embeds: [embed] });
    } catch (error) {
      console.error('Failed to send DM:', error.message);
    }
  }

  async presence(title, desc, uid, game = null, loc = 'Unknown') {
    const name = names[uid] || uid.toString();

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(desc)
      .setColor('#36393F')
      .addFields(
        { name: 'User', value: name, inline: true },
        { name: 'Last Location', value: loc, inline: true }
      )
      .setTimestamp();

    if (game?.name && game?.placeId) {
      embed.addFields(
        { name: 'Game Name', value: game.name, inline: true },
        { name: 'Game ID', value: game.placeId.toString(), inline: true },
        { name: 'Game Link', value: `[Play Now](https://www.roblox.com/games/${game.placeId})`, inline: true }
      );
    }

    await this.#dm(embed);
  }

  async friend(uid, fid, fname, type) {
    const nick = names[uid] || uid.toString();
    const added = type === 'added';
    
    const title = added ? `✅ New Friend` : `❌ Friend Removed`;
    const msg = added
      ? `**${nick}** became friends with [${fname}](https://roblox.com/users/${fid}/profile)`
      : `**${nick}** and [${fname}](https://roblox.com/users/${fid}/profile) are no longer friends`;

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(msg)
      .setColor('#36393F')
      .setTimestamp();

    await this.#dm(embed);
  }

  async follow(uid, fid, fname, type) {
    const nick = names[uid] || uid.toString();
    const followed = type === 'followed';
    
    const title = followed ? `👥 Now Following` : `👋 Unfollowed`;
    const msg = followed
      ? `**${nick}** is now following [${fname}](https://roblox.com/users/${fid}/profile)`
      : `**${nick}** unfollowed [${fname}](https://roblox.com/users/${fid}/profile)`;

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(msg)
      .setColor('#36393F')
      .setTimestamp();

    await this.#dm(embed);
  }
}

class tracker {
  constructor(api, cache, notifs) {
    this.api = api;
    this.cache = cache;
    this.notifs = notifs;
    this.timers = new Map();
  }

  async checkPresence(uid) {
    try {
      const status = await this.api.getUserStatus(uid);
      if (!status) return;

      const old = this.cache.getStatus(uid);
      const online = status.userPresenceType >= 1;
      const gid = status.placeId || null;
      const loc = status.lastLocation || 'Unknown';
      const priv = status.userPresenceType === 2 && status.lastLocation === "";
      const now = { online, gid, loc, priv };

      const changed =
        old.online !== online ||
        old.gid !== gid ||
        (old.loc !== loc && loc !== 'Unknown') ||
        (priv && !old.priv);

      if (changed) {
        await this.#handleChange(uid, old, now, status);
        this.cache.setStatus(uid, now);
        await this.cache.saveStatus();
      }
    } catch (error) {
      console.error(`Presence check error for user ${uid}:`, error.message);
    }
  }

  async #handleChange(uid, old, now, status) {
    const name = names[uid] || uid.toString();
    const { online, gid, loc, priv } = now;

    if (priv && !old.priv) {
      await this.notifs.presence(
        `${name} joined a game with joins off`,
        `${name} has joined a game with joins disabled.\nLast Location: Not visible (joins off)`,
        uid, null, 'Not visible (joins off)'
      );
    } else if (old.online !== online) {
      const txt = online ? 'online' : 'offline';
      await this.notifs.presence(
        `${name} is now ${txt}`,
        `${name} is now ${txt} on Roblox.\nLast Location: ${loc}`,
        uid, null, loc
      );
    } else if (old.gid !== gid) {
      if (gid) {
        const game = await this.api.getGameInfo(gid);
        const gname = game ? game.name : loc || 'Unknown Game';
        await this.notifs.presence(
          `${name} joined a game`,
          `${name} joined the game: ${gname}\nGame ID: ${gid}\nLink: https://www.roblox.com/games/${gid}\nLast Location: ${loc}`,
          uid,
          game ? { name: game.name, placeId: gid } : { name: gname, placeId: gid },
          loc
        );
      } else {
        await this.notifs.presence(
          `${name} left the game`,
          `${name} has left the game.\nLast Location: ${loc}`,
          uid, null, loc
        );
      }
    } else if (old.loc !== loc && loc !== 'Unknown') {
      const game = gid ? await this.api.getGameInfo(gid) : null;
      await this.notifs.presence(
        `${name} location updated`,
        `${name} last location updated to: ${loc}${gid ? `\nCurrent Game ID: ${gid}\nGame Link: https://www.roblox.com/games/${gid}` : ''}`,
        uid,
        game ? { name: game.name || loc || 'Unknown Game', placeId: gid } : null,
        loc
      );
    }
  }

  async checkFriends(uid) {
    try {
      const current = await this.api.getUserFriends(uid);
      if (!current) return;

      const old = this.cache.getFriends(uid);
      const { added, removed } = this.#diff(old, current);

      for (const fid of added) {
        const fname = await this.api.getUsername(fid);
        await this.notifs.friend(uid, fid, fname, 'added');
        await this.#wait();
      }

      for (const fid of removed) {
        const fname = await this.api.getUsername(fid);
        await this.notifs.friend(uid, fid, fname, 'removed');
        await this.#wait();
      }

      if (added.length > 0 || removed.length > 0) {
        this.cache.setFriends(uid, current);
        await this.cache.saveFriends();
      }
    } catch (error) {
      console.error(`Friend check error for user ${uid}:`, error.message);
    }
  }

  async checkFollowing(uid) {
    try {
      const current = await this.api.getUserFollowing(uid);
      if (!current) return;

      const old = this.cache.getFollowing(uid);
      const { added, removed } = this.#diff(old, current);

      for (const fid of added) {
        const fname = await this.api.getUsername(fid);
        await this.notifs.follow(uid, fid, fname, 'followed');
        await this.#wait();
      }

      for (const fid of removed) {
        const fname = await this.api.getUsername(fid);
        await this.notifs.follow(uid, fid, fname, 'unfollowed');
        await this.#wait();
      }

      if (added.length > 0 || removed.length > 0 || old.length === 0) {
        this.cache.setFollowing(uid, current);
        await this.cache.saveFollowing();
      }
    } catch (error) {
      console.error(`Following check error for user ${uid}:`, error.message);
    }
  }

  #diff(old, now) {
    const nowset = new Set(now);
    const oldset = new Set(old);
    
    return {
      added: now.filter(id => !oldset.has(id)),
      removed: old.filter(id => !nowset.has(id))
    };
  }

  async #wait() {
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  start(users) {
    this.timers.set('presence', setInterval(() => {
      users.forEach(uid => this.checkPresence(uid));
    }, 10000));

    this.timers.set('friends', setInterval(async () => {
      for (const uid of users) {
        await this.checkFriends(uid);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }, 30000));

    this.timers.set('following', setInterval(async () => {
      for (const uid of users) {
        await this.checkFollowing(uid);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }, 30000));

    setTimeout(() => users.forEach(uid => this.checkPresence(uid)), 1000);
    setTimeout(async () => {
      for (const uid of users) {
        await this.checkFriends(uid);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }, 30000);
    setTimeout(async () => {
      for (const uid of users) {
        await this.checkFollowing(uid);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }, 10000);
  }

  stop() {
    this.timers.forEach(timer => clearInterval(timer));
    this.timers.clear();
  }
}

const bot = new Client({ 
  intents: [GatewayIntentBits.DirectMessages, GatewayIntentBits.Guilds], 
  partials: ['CHANNEL'] 
});

const msgs = new notifs(bot, discordid);
const monitor = new tracker(rblx, storage, msgs);

bot.once('ready', async () => {
  console.log(`🤖 bot ready: ${bot.user.tag}`);
  
  try {
    await storage.loadAll();
    console.log('📂 cache loaded');
    
    monitor.start(usersToWatch);
    console.log(`👀 monitoring ${usersToWatch.length} users`);
    
  } catch (error) {
    console.error('❌ monitoring error:', error.message);
    process.exit(1);
  }
});

bot.on('error', (error) => {
  console.error('Discord bot error:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('SIGINT', () => {
  console.log('\n🛑 stopping');
  monitor.stop();
  bot.destroy();
  process.exit(0);
});

bot.login(token).catch(error => {
  console.error('❌ failed to login:', error.message);
  process.exit(1);
});