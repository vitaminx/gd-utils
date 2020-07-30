#!/usr/bin/env node

const { argv } = require('yargs')
  .usage('用法: ./$0 folder-id\nfolder-id 是你想檢測SA是否對其有閱讀權限的目錄ID')
  .help('h')
  .alias('h', 'help')

const fs = require('fs')
const path = require('path')
const prompts = require('prompts')
const { GoogleToken } = require('gtoken')
const axios = require('@viegg/axios')
const HttpsProxyAgent = require('https-proxy-agent')

const { https_proxy } = process.env
const axins = axios.create(https_proxy ? { httpsAgent: new HttpsProxyAgent(https_proxy) } : {})

const SA_FILES = fs.readdirSync(path.join(__dirname, 'sa')).filter(v => v.endsWith('.json'))
const SA_TOKENS = SA_FILES.map(filename => {
  const gtoken = new GoogleToken({
    keyFile: path.join(__dirname, 'sa', filename),
    scope: ['https://www.googleapis.com/auth/drive']
  })
  return {gtoken, filename}
})

main()
async function main () {
  const [fid] = argv._
  if (validate_fid(fid)) {
    console.log('開始檢測', SA_TOKENS.length, '個SA帳號')
    const invalid_sa = await get_invalid_sa(SA_TOKENS, fid)
    if (!invalid_sa.length) return console.log('已檢測', SA_TOKENS.length, '個SA，未檢測到無效帳號')
    const choice = await choose(invalid_sa.length)
    if (choice === 'yes') {
      mv_sa(invalid_sa)
      console.log('成功移動')
    } else {
      console.log('成功退出，無效的SA記錄：', invalid_sa)
    }
  } else {
    console.warn('目錄ID缺失或格式錯誤')
  }
}

function mv_sa (arr) {
  for (const filename of arr) {
    const oldpath = path.join(__dirname, 'sa', filename)
    const new_path = path.join(__dirname, 'sa/invalid', filename)
    fs.renameSync(oldpath, new_path)
  }
}

async function choose (count) {
  const answer = await prompts({
    type: 'select',
    name: 'value',
    message: `檢測到 ${count} 個無效的SA，是否將它們移動到 sa/invalid 目錄下？`,
    choices: [
      { title: 'Yes', description: '確認移動', value: 'yes' },
      { title: 'No', description: '不做更改，直接退出', value: 'no' }
    ],
    initial: 0
  })
  return answer.value
}

async function get_invalid_sa (arr, fid) {
  if (!fid) throw new Error('請指定要檢測權限的目錄ID')
  const fails = []
  let flag = 0
  let good = 0
  for (const v of arr) {
    console.log('檢測進度', `${flag++}/${arr.length}`)
    console.log('正常/異常', `${good}/${fails.length}`)
    const {gtoken, filename} = v 
    try {
      const access_token = await get_sa_token(gtoken)
      await get_info(fid, access_token)
      good++
    } catch (e) {
      handle_error(e)
      const status = e && e.response && e.response.status
      if (Number(status) === 400) fails.push(filename) // access_token 获取失败

      const data = e && e.response && e.response.data
      const code = data && data.error && data.error.code
      if ([404, 403].includes(Number(code))) fails.push(filename) // 读取文件夹信息失败
    }
  }
  return fails
}

function handle_error (err) {
  const data = err && err.response && err.response.data
  if (data) {
    console.error(JSON.stringify(data))
  } else {
    console.error(err.message)
  }
}

async function get_info (fid, access_token) {
  let url = `https://www.googleapis.com/drive/v3/files/${fid}`
  let params = {
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    corpora: 'allDrives',
    fields: 'id,name'
  }
  url += '?' + params_to_query(params)
  const headers = { authorization: 'Bearer ' + access_token }
  const { data } = await axins.get(url, { headers })
  return data
}

function params_to_query (data) {
  const ret = []
  for (let d in data) {
    ret.push(encodeURIComponent(d) + '=' + encodeURIComponent(data[d]))
  }
  return ret.join('&')
}

async function get_sa_token (gtoken) {
  return new Promise((resolve, reject) => {
    gtoken.getToken((err, tk) => {
      err ? reject(err) : resolve(tk.access_token)
    })
  })
}

function validate_fid (fid) {
  if (!fid) return false
  fid = String(fid)
  if (fid.length < 10 || fid.length > 100) return false
  const reg = /^[a-zA-Z0-9_-]+$/
  return fid.match(reg)
}
