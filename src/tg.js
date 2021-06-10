const Table = require('cli-table3')
const dayjs = require('dayjs')
const axios = require('@viegg/axios')
const HttpsProxyAgent = require('https-proxy-agent')

const { db } = require('../db')
const { gen_count_body, validate_fid, real_copy, get_name_by_id, get_info_by_id, copy_file } = require('./gd')
const { AUTH, DEFAULT_TARGET, USE_PERSONAL_AUTH } = require('../config')
const { BUTTON_LEVEL } = require('../config_mod')
const { tg_token } = AUTH
const gen_link = (fid, text) => `<a href="https://drive.google.com/drive/folders/${fid}">${text || fid}</a>`

if (!tg_token) throw new Error('請先在config.js裡設定tg_token')
const { https_proxy } = process.env
const axins = axios.create(https_proxy ? { httpsAgent: new HttpsProxyAgent(https_proxy) } : {})

const FID_TO_NAME = {}

async function get_folder_name (fid) {
  let name = FID_TO_NAME[fid]
  if (name) return name
  name = await get_name_by_id(fid, !USE_PERSONAL_AUTH)
  return FID_TO_NAME[fid] = name
}

function send_help (chat_id) {
  const text = `<pre>[使用說明]
命令 ｜ 說明
=====================
/help | 返回本使用說明
=====================
/count sourceID [-u] | 返回sourceID的文件統計資訊
sourceID可以是共享網址本身，也可以是共享ID。如果命令最后加上 -u，則無視快取記錄強制從線上獲取，適合一段時候後才更新完畢的分享連結。
=====================
/copy sourceID targetID(選填) [-u] | 將sourceID的文件複製到targetID裡（會新建一個資料夾）
若無targetID，則會複製到預設位置（config.js中的DEFAULT_TARGET）。
如果設定了bookmark，那麼targetID也可以是bookmark的標籤名。
如果命令最後加上 -u，則無視快取記錄強制從線上獲取源資料夾資訊。返回拷貝任務的taskID
=====================
/task taskID(選填) | 返回對應任務的進度信息，若不填taskID則返回所有正在運行的任務進度
若填 all 則返回所有任務列表(歷史紀錄)
/task | 返回所有正在執行的正在執行的任務詳情
/task 7 | 返回ID为 7 的任務詳情
/task all | 返回所有任務紀錄列表
/task clear | 清除所有狀態為finished的任務紀錄
/task rm 7 | 刪除編號為 7 的任務紀錄
=====================
/bm [action] [alias] [target] | bookmark，添加常用目的資料夾ID
會在輸入共享連結後返回的「文件統計」「開始複製」這兩個按鈕的下方出現，方便複製到常用位置。
範例：
/bm | 返回所有設定的資料夾
/bm set movie folder-id | 將folder-id加入到收藏夾，標籤名設為movie
/bm unset movie | 刪除此收藏夾
</pre>`
  return sm({ chat_id, text, parse_mode: 'HTML' })
}

function send_bm_help (chat_id) {
  const text = `<pre>/bm [action] [alias] [target] | bookmark，添加常用目的資料夾ID
會在輸入共享連結後返回的「文件統計」「開始複製」這兩個按鈕的下方出現，方便複製到常用位置。
範例：
/bm | 返回所有設定的資料夾
/bm set movie folder-id | 將folder-id加入到收藏夾，標籤名設為movie
/bm unset movie | 刪除此收藏夾
</pre>`
  return sm({ chat_id, text, parse_mode: 'HTML' })
}

function send_task_help (chat_id) {
  const text = `<pre>/task [action/id] [id] | 查詢或管理任務進度
範例：
/task | 返回所有正在執行的正在執行的任務詳情
/task 7 | 返回ID为 7 的任務詳情
/task all | 返回所有任務紀錄列表
/task clear | 清除所有狀態為finished的任務紀錄
/task rm 7 | 刪除編號為 7 的任務紀錄
</pre>`
  return sm({ chat_id, text, parse_mode: 'HTML' })
}

function clear_tasks (chat_id) {
  const finished_tasks = db.prepare('select id from task where status=?').all('finished')
  finished_tasks.forEach(task => rm_task({ task_id: task.id }))
  sm({ chat_id, text: '已清除所有狀態為finished的任務紀錄' })
}

function rm_task ({ task_id, chat_id }) {
  const exist = db.prepare('select id from task where id=?').get(task_id)
  if (!exist) return sm({ chat_id, text: `不存在任務ID為 ${task_id} 的任務記錄` })
  db.prepare('delete from task where id=?').run(task_id)
  db.prepare('delete from copied where taskid=?').run(task_id)
  if (chat_id) sm({ chat_id, text: `已刪除任務 ${task_id} 記錄` })
}

function send_all_bookmarks (chat_id) {
  let records = db.prepare('select alias, target from bookmark').all()
  if (!records.length) return sm({ chat_id, text: '數據庫中沒有收藏記錄' })
  const tb = new Table({ style: { head: [], border: [] } })
  const headers = ['標籤名', 'dstID']
  records = records.map(v => [v.alias, v.target])
  tb.push(headers, ...records)
  const text = tb.toString().replace(/─/g, '—')
  return sm({ chat_id, text: `<pre>${text}</pre>`, parse_mode: 'HTML' })
}

function set_bookmark ({ chat_id, alias, target }) {
  const record = db.prepare('select alias from bookmark where alias=?').get(alias)
  if (record) return sm({ chat_id, text: '資料庫中已有同名的收藏' })
  db.prepare('INSERT INTO bookmark (alias, target) VALUES (?, ?)').run(alias, target)
  return sm({ chat_id, text: `成功設定收藏：${alias} | ${target}` })
}

function unset_bookmark ({ chat_id, alias }) {
  const record = db.prepare('select alias from bookmark where alias=?').get(alias)
  if (!record) return sm({ chat_id, text: '未找到此標籤名的收藏' })
  db.prepare('delete from bookmark where alias=?').run(alias)
  return sm({ chat_id, text: '成功刪除收藏 ' + alias })
}

function get_target_by_alias (alias) {
  const record = db.prepare('select target from bookmark where alias=?').get(alias)
  return record && record.target
}

function get_alias_by_target (target) {
  const record = db.prepare('select alias from bookmark where target=?').get(target)
  return record && record.alias
}

function send_choice ({ fid, chat_id }) {
  if(BUTTON_LEVEL == 1){
  	return sm({
    chat_id,
    text: `辨識到分享ID ${fid}，請選擇動作`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: '文件統計', callback_data: `count ${fid}` }
        ],
        [
          { text: '開始複製', callback_data: `copy ${fid}` }
        ]
      ].concat(gen_bookmark_choices(fid)).concat([[
          { text: '強制更新', callback_data: `update ${fid}` },
          { text: '清除按鈕', callback_data: `clear_button` }
        ]])
    }
  	})
  }else{
  	return sm({
    chat_id,
    text: `辨識到分享ID ${fid}，請選擇動作`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: '文件統計', callback_data: `count ${fid}` },
          { text: '開始複製', callback_data: `copy ${fid}` }
        ]
      ].concat(gen_bookmark_choices(fid)).concat([[
          { text: '強制更新', callback_data: `update ${fid}` },
          { text: '清除按鈕', callback_data: `clear_button` }
        ]])
    }
  	})
  }
}

// console.log(gen_bookmark_choices())
function gen_bookmark_choices (fid) {
  let level = 1
  if (BUTTON_LEVEL > 2){
  	level = 2
  }else{
  	level = BUTTON_LEVEL
  }
  const gen_choice = v => ({ text: `複製到 ${v.alias}`, callback_data: `copy ${fid} ${v.alias}` })
  const records = db.prepare('select * from bookmark').all()
  const result = []
  for (let i = 0; i < records.length; i += 2) {
    const line = [gen_choice(records[i])]
    if (records[i + 1]) line.push(gen_choice(records[i + 1]))
    result.push(line)
  }
  return result
}

async function send_all_tasks (chat_id) {
  let records = db.prepare('select id, status, ctime from task').all()
  if (!records.length) return sm({ chat_id, text: '資料庫中沒有任務記錄' })
  const tb = new Table({ style: { head: [], border: [] } })
  const headers = ['ID', 'status', 'ctime']
  records = records.map(v => {
    const { id, status, ctime } = v
    return [id, status, dayjs(ctime).format('YYYY-MM-DD HH:mm:ss')]
  })
  tb.push(headers, ...records)
  const text = tb.toString().replace(/─/g, '—')
  const url = `https://api.telegram.org/bot${tg_token}/sendMessage`
  return axins.post(url, {
    chat_id,
    parse_mode: 'HTML',
    text: `所有拷貝任務：\n<pre>${text}</pre>`
  }).catch(err => {
    // const description = err.response && err.response.data && err.response.data.description
    // if (description && description.includes('message is too long')) {
    if (true) {
      const text = [headers].concat(records.slice(-100)).map(v => v.join('\t')).join('\n')
      return sm({ chat_id, parse_mode: 'HTML', text: `所有拷貝任務(僅顯示最近100項)：\n<pre>${text}</pre>` })
    }
    console.error(err)
  })
}

async function get_task_info (task_id) {
  const record = db.prepare('select * from task where id=?').get(task_id)
  if (!record) return {}
  const { source, target, status, mapping, ctime, ftime } = record
  const { copied_files } = db.prepare('select count(fileid) as copied_files from copied where taskid=?').get(task_id)
  const folder_mapping = mapping && mapping.trim().split('\n')
  const new_folder = folder_mapping && folder_mapping[0].split(' ')[1]
  const { summary } = db.prepare('select summary from gd where fid=?').get(source) || {}
  const { file_count, folder_count, total_size } = summary ? JSON.parse(summary) : {}
  const total_count = (file_count || 0) + (folder_count || 0)
  const copied_folders = folder_mapping ? (folder_mapping.length - 1) : 0
  let text = '任務ID：' + task_id + '    [' + status + ']\n'
  const folder_name = await get_folder_name(source)
  text += '源資料夾：' + gen_link(source, folder_name) + '\n'
  text += '目的位置：' + gen_link(target, get_alias_by_target(target)) + '\n'
  text += '新資料夾：' + (new_folder ? gen_link(new_folder) : '尚未創建') + '\n'
  text += '任務狀態：' + status + '\n'
  text += '創建時間：' + dayjs(ctime).format('YYYY-MM-DD HH:mm:ss') + '\n'
  text += '完成時間：' + (ftime ? dayjs(ftime).format('YYYY-MM-DD HH:mm:ss') : '未完成') + '\n'
  text += '目錄進度：' + copied_folders + '/' + (folder_count === undefined ? '未知數量' : folder_count) + ' - ' + (copied_folders/folder_count*100).toFixed(3) + '%\n'
  text += '文件進度：' + copied_files + '/' + (file_count === undefined ? '未知數量' : file_count) + ' - ' + (copied_files/file_count*100).toFixed(3) + '%\n'
  text += '合計大小：' + (total_size || '未知大小')
  return { text, status, folder_count }
}

async function send_task_info ({ task_id, chat_id }) {
  const { text, status, folder_count } = await get_task_info(task_id)
  if (!text) return sm({ chat_id, text: '資料庫查無此任務ID：' + task_id })
  const url = `https://api.telegram.org/bot${tg_token}/sendMessage`
  let message_id
  try {
    const { data } = await axins.post(url, { chat_id, text, parse_mode: 'HTML' })
    message_id = data && data.result && data.result.message_id
  } catch (e) {
    console.log('fail to send message to tg', e.message)
  }
  // get_task_info 在task目录数超大时比较吃cpu，以后如果最好把mapping也另存一张表
  if (!message_id || status !== 'copying') return
  const loop = setInterval(async () => {
    const { text, status } = await get_task_info(task_id)
    if (status !== 'copying') clearInterval(loop)
    sm({ chat_id, message_id, text, parse_mode: 'HTML' }, 'editMessageText')
  }, 10 * 1000)
}

async function tg_copy ({ fid, target, chat_id, update }) { // return task_id
  target = target || DEFAULT_TARGET
  if (!target) {
    sm({ chat_id, text: '請輸入目的地ID或先在config.js中設定預設複製的目的地ID(DEFAULT_TARGET)' })
    return
  }
  const file = await get_info_by_id(fid, !USE_PERSONAL_AUTH)
  if (file && file.mimeType !== 'application/vnd.google-apps.folder') {
    return copy_file(fid, target, !USE_PERSONAL_AUTH).then(data => {
      sm({ chat_id, parse_mode: 'HTML', text: `單檔複製成功，位置：${gen_link(target)}` })
    }).catch(e => {
      sm({ chat_id, text: `單檔複製成功失敗，失敗訊息：${e.message}` })
    })
  }

  let record = db.prepare('select id, status from task where source=? and target=?').get(fid, target)
  if (record) {
    if (record.status === 'copying') {
      sm({ chat_id, text: '已有相同來源ID和目的ID的任務正在進行，查詢進度可輸入 /task ' + record.id })
      return
    } else if (record.status === 'finished') {
      sm({ chat_id, text: `檢測到已存在的任務 ${record.id}，開始繼續拷貝` })
    }
  }

  real_copy({ source: fid, update, target, service_account: !USE_PERSONAL_AUTH, is_server: true })
    .then(async info => {
      if (!record) record = {} // 防止無限循環
      if (!info) return
      const { task_id } = info
      const { text } = await get_task_info(task_id)
      sm({ chat_id, text, parse_mode: 'HTML' })
    })
    .catch(err => {
      const task_id = record && record.id
      if (task_id) db.prepare('update task set status=? where id=?').run('error', task_id)
      if (!record) record = {}
      console.error('複製失敗', fid, '-->', target)
      console.error(err)
      sm({ chat_id, text: (task_id || '') + '複製失敗，失敗訊息：' + err.message })
    })

  while (!record) {
    record = db.prepare('select id from task where source=? and target=?').get(fid, target)
    await sleep(1000)
  }
  return record.id
}

function sleep (ms) {
  return new Promise((resolve, reject) => {
    setTimeout(resolve, ms)
  })
}

function reply_cb_query ({ id, data }) {
  const url = `https://api.telegram.org/bot${tg_token}/answerCallbackQuery`
  return axins.post(url, {
    callback_query_id: id,
    text: '開始執行 ' + data
  })
}

async function send_count ({ fid, chat_id, update }) {
  sm({ chat_id, text: `開始獲取 ${fid} 所有檔案資訊，請稍後，建議統計完成前先不要開始複製，因为複製也需要先獲取來源資料夾資訊` })
  const table = await gen_count_body({ fid, update, type: 'tg', service_account: !USE_PERSONAL_AUTH })
  if (!table) return sm({ chat_id, parse_mode: 'HTML', text: gen_link(fid) + ' 資訊獲取失敗' })
  const url = `https://api.telegram.org/bot${tg_token}/sendMessage`
  const gd_link = `https://drive.google.com/drive/folders/${fid}`
  const name = await get_folder_name(fid)
  return axins.post(url, {
    chat_id,
    parse_mode: 'HTML',
    text: `<pre>源資料夾名稱：${name}
源連結：${gd_link}
${table}</pre>`
  }).catch(async err => {
    // const description = err.response && err.response.data && err.response.data.description
    // const too_long_msgs = ['request entity too large', 'message is too long']
    // if (description && too_long_msgs.some(v => description.toLowerCase().includes(v))) {
    if (true) {
      const smy = await gen_count_body({ fid, type: 'json', service_account: !USE_PERSONAL_AUTH })
      const { file_count, folder_count, total_size } = JSON.parse(smy)
      return sm({
        chat_id,
        parse_mode: 'HTML',
        text: `連結：<a href="https://drive.google.com/drive/folders/${fid}">${fid}</a>\n<pre>
表格太長超出telegram訊息限制，僅顯示概要：
目錄名稱：${name}
文件總數：${file_count}
目錄總數：${folder_count}
合計大小：${total_size}
</pre>` 
      })
    }
    throw err
  })
}

function sm (data, endpoint) {
  endpoint = endpoint || 'sendMessage'
  const url = `https://api.telegram.org/bot${tg_token}/${endpoint}`
  return axins.post(url, data).catch(err => {
    // console.error('fail to post', url, data)
    console.error('fail to send message to tg:', err.message)
    const err_data = err.response && err.response.data
    err_data && console.error(err_data)
  })
}

function extract_fid (text) {
  text = text.replace(/^\/count/, '').replace(/^\/copy/, '').replace(/\\/g, '').trim()
  const [source, target] = text.split(' ').map(v => v.trim())
  if (validate_fid(source)) return source
  try {
    if (!text.startsWith('http')) text = 'https://' + text
    const u = new URL(text)
    if (u.pathname.includes('/folders/')) {
      return u.pathname.split('/').map(v => v.trim()).filter(v => v).pop()
    } else if (u.pathname.includes('/file/')) {
      const file_reg = /file\/d\/([a-zA-Z0-9_-]+)/
      const file_match = u.pathname.match(file_reg)
      return file_match && file_match[1]
    }
    return u.searchParams.get('id')
  } catch (e) {
    return ''
  }
}

function extract_from_text (text) {
  // const reg = /https?:\/\/drive.google.com\/[^\s]+/g
  const reg = /https?:\/\/drive.google.com\/[a-zA-Z0-9_\\/?=&-]+/g
  const m = text.match(reg)
  return m && extract_fid(m[0])
}

module.exports = { send_count, send_help, sm, extract_fid, reply_cb_query, send_choice, send_task_info, send_all_tasks, tg_copy, extract_from_text, get_target_by_alias, send_bm_help, send_all_bookmarks, set_bookmark, unset_bookmark, clear_tasks, send_task_help, rm_task }
