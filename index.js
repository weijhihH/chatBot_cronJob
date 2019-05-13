const express = require('express');
const CronJob = require('cron').CronJob;
const moment = require('moment');
const mysql = require('mysql');
const key = require('./util/key.js');
const axios = require('axios');

const app = express();
// MySql Connected
const db = mysql.createPool({
  connectionLimit: 100,
  host: key.MYSQL.host,
  user: key.MYSQL.user,
  password: key.MYSQL.password,
  database: key.MYSQL.database,
});
const Port = '8090'



let broadcast = async function () {
  try{
    let timeNow = moment().utc() // 先設定一個 timeNow , 用utc()
    const timeNowPlus24Hours = timeNow.clone().add('24', 'hours').valueOf()
    // console.log('timeNowPlus24Hours',timeNowPlus24Hours)
    // 進資料庫找資料, 由 broadcastSet Table 當作起點搜索
    const selectQuery = `select broadcastSet.pageId, broadcastSet.startDate, broadcastSet.startTime, broadcastSet.timezone as broadcastTimezone, people.PSID, 
    people.timezone, people.lastSeen, people.times, rule.rule ,(case when lastSeen > ${timeNowPlus24Hours} then 'smallThanOneDay' ELSE 'bigThanOneDay' end) as differenceBetweenRealTime,
    sendMessage.event, sendMessage.info, pages.pageAccessToken
    from broadcastSet
    inner join people 
    on broadcastSet.pageId = people.pageId 
    left join sendMessage
    on people.pageId = sendMessage.pageId
    left join pages
    on sendMessage.pageId = pages.pageId
    left join broadcastRepeat
    on people.pageId = broadcastRepeat.pageId
    left join rule 
    on broadcastRepeat.ruleId = rule.ruleId
    where sendMessage.source = 'broadcast';`

    let broadcastList = await mysqlSingleQuery(selectQuery)
    // 結果每一筆資料去分析是否推播
    let theSameDayStatus = {};
    broadcastList.forEach(e => {
      // 當粉絲頁指定推播時間用 userTimeZone
      // 將 mysql 內時間先用 utc +00:00 表示
      // 日期上時間
      const timeFromUserSetting = moment(`${e.startDate} ${e.startTime} +00:00`,'MM/DD/YYYY HH:mm Z').utc()
      // 只有時間
      const timeFromUserSettingHHmm = moment(`${e.startTime} +00:00`,'HH:mm Z').utc()
      // 將mysql內星期幾換成數字
      const repeatDate = convertDateToNumber(e.rule)
      // 將 目前時間加上 usertimezone 
      // console.log('timeNow',timeNow.format());
      // console.log('timeFromUserSetting',timeFromUserSetting.format())
      
      if(e.broadcastTimezone === 'userTimezone'){
        const timeNowPlusUserTimezone = timeNow.clone().add(e.timezone,'hours')
        // console.log('timeNowPlusUserTimezone',timeNowPlusUserTimezone.format())
        // 比較時間 , 當時間已經比設定時間晚, 則 repeat 設定時,比對 repeat 週期時間跟 hh:mm 對上的時候就可以推播
        if(timeFromUserSetting.isBefore(timeNowPlusUserTimezone,'day') &&
          timeFromUserSettingHHmm.isSame(timeNowPlusUserTimezone,'minute') &&
          repeatDate === timeNowPlusUserTimezone.day()){
            sendBroadcastMessageUseUserTimezone(e)
        }
        // 當粉絲頁指定推播時間用 botTimeZone (UTC +00:00//)
      }else if (e.broadcastTimezone === 'botTimezone'){
        // 比較時間 , 當時間已經比設定時間晚, 則 repeat 設定時,比對 repeat 週期時間跟 hh:mm 對上的時候就可以推播
        if(timeFromUserSetting.isBefore(timeNow,'day') &&
          timeFromUserSettingHHmm.isSame(timeNow,'minute') &&
          repeatDate === timeNow.day()){
          sendBroadcastMessageUseUserTimezone(e)
        }
      }
    })
    const selectQueryNoDuplicate = `select broadcastSet.pageId, broadcastSet.startDate, broadcastSet.startTime, broadcastSet.timezone as broadcastTimezone, people.PSID, 
    people.timezone, people.lastSeen, people.times,
    sendMessage.event, sendMessage.info, pages.pageAccessToken
    from broadcastSet
    inner join people 
    on broadcastSet.pageId = people.pageId 
    left join sendMessage
    on people.pageId = sendMessage.pageId
    left join pages
    on sendMessage.pageId = pages.pageId
    where sendMessage.source = 'broadcast';`
    let broadcastListNoDuplicate = await mysqlSingleQuery(selectQueryNoDuplicate)
    broadcastListNoDuplicate.forEach(e => {
      // 當粉絲頁指定推播時間用 userTimeZone
      // 將 mysql 內時間先用 utc +00:00 表示
      // 日期上時間
      const timeFromUserSetting = moment(`${e.startDate} ${e.startTime} +00:00`,'MM/DD/YYYY HH:mm Z').utc()
      // 將 目前時間加上 usertimezone 
      // console.log('timeNow',timeNow.format());
      // console.log('timeFromUserSetting',timeFromUserSetting.format())
      
      if(e.broadcastTimezone === 'userTimezone'){
        const timeNowPlusUserTimezone = timeNow.clone().add(e.timezone,'hours')
        // console.log('timeNowPlusUserTimezone',timeNowPlusUserTimezone.format())

        // 比較時間 , 事件觸發點事件, 不用考慮 repeatDate
        if(timeFromUserSetting.isSame(timeNowPlusUserTimezone,'minute')){
          // 將 theSameDay 狀態改變, 並且用狀態控制發訊息數量
            // messageCreatives
            // console.log('e.pageAccessToken',e.pageAccessToken)
            sendBroadcastMessageUseUserTimezone(e)
        }
        // 當粉絲頁指定推播時間用 botTimeZone (UTC +00:00//)
      }else if (e.broadcastTimezone === 'botTimezone'){
        // 比較時間 , 當時間是同一天同一分鐘, 則當天發生的事件, 不用考慮 repeat
        if(timeFromUserSetting.isSame(timeNow,'minute')){
          sendBroadcastMessageUseUserTimezone(e)
        }
      }
    })
  }catch (error){
    console.log('error', error)
  }
}


new CronJob('*/1 * * * *', function() {
  // cron job code write here
  console.log('111')
  broadcast();
}, null, true, 'Europe/London');


app.listen(Port, () => {
  console.log('Server connected on port ' + Port);
});

function mysqlSingleQuery (query){
  return new Promise((resolve, reject) => {
    db.query(query, (err, result) => {
      if (err){
        return reject(err)
      }
      return resolve(result)
    })
  })
}

// 轉換日期 0~6 -> sunday to saturday
function convertDateToNumber (date) {
  switch (date){
    case 'sunday':
    return 0
  case 'monday':
    return 1
  case 'tuesday':
    return 2
  case 'wednesday':
    return 3
  case 'thursday':
    return 4
  case 'friday':
    return 5
  case 'saturday':
    return 6
  }
}

async function sendBroadcastMessageToFacebook (){
  try{
    await axios1() 
    console.log('1')
  }catch(err){
    console.log(err);
  }
}

// 創造 content , 輸入的時候要區分格式

let sendBroadcastMessageUseUserTimezone = async function (content) {
  try {
    const accessToken = content.pageAccessToken
    const body = content.info 
    const PSID = content.PSID
    const event = content.event
    axiosMessageSend(accessToken,body,PSID,event)
  } catch (err){
    console.log('err', err)
  }
}

let sendBroadcastMessageUseBotTimezone = async function (accessToken,content, event) {
  try {
    const axiosMessageCreativesResult = await axiosMessageCreatives(accessToken,content, event)
    const messageCreativesId = axiosMessageCreativesResult.message_creative_id
    console.log('axiosMessageCreativesResult',messageCreativesId)
    axiosMessageSendNoLabelId(accessToken,messageCreativesId)
  } catch (err){
    console.log('err', err)
  }
}


function axiosMessageCreatives (accessToken,content, event){
  let body;
  if(event === 'message'){
    body = {
      "messages": [
        content
      ]
    }
  }
  
  return new Promise ((resolve, reject) => {
    axios({
      method: 'post',
      url: `https://graph.facebook.com/v3.3/me/message_creatives?access_token=${accessToken}`,
      headers: {
        'Content-Type': 'application/json'
      },
      data: body
    })
    .then((res) => {
      console.log('res', res.data)
      return resolve(res.data)
    })
    .catch((err) => {
      console.log('err', err.response.data)
      return reject(err.response.data)
    })
  })
}

function axiosMessageSend (accessToken,body,PSID,event){
  let requestBody;
    requestBody = {
      "messaging_type": "UPDATE",
      "recipient": {
        "id": PSID
      },
      "message": body
    }

  console.log('requestBody', requestBody)
  console.log('accessToken',accessToken)
  return new Promise ((resolve, reject) => {
    axios({
      method: 'post',
      url: `https://graph.facebook.com/v3.3/me/messages?access_token=${accessToken}`,
      headers: {
        'Content-Type': 'application/json'
      },
      data: requestBody
    })
    .then((res) => {
      console.log('res', res.data)
      return resolve(res.data)
    })
    .catch((err) => {
      console.log('err', err.response.data)
      return reject(err.response.data)
    })
  })
}

function axiosMessageSendNoLabelId (accessToken,messageCreativesId){
  let requestBody = {    
    "message_creative_id": messageCreativesId,
    "notification_type": "SILENT_PUSH",
    "messaging_type": "MESSAGE_TAG",
    "tag": "NON_PROMOTIONAL_SUBSCRIPTION"
  }
  console.log('accessToken',accessToken)
  return new Promise ((resolve, reject) => {
    axios({
      method: 'post',
      url: `https://graph.facebook.com/v2.11/me/broadcast_messages?access_token=${accessToken}`,
      headers: {
        'Content-Type': 'application/json'
      },
      data: requestBody
    })
    .then((res) => {
      console.log('res', res.data)
      return resolve(res.data)
    })
    .catch((err) => {
      console.log('err', err.response.data)
      return reject(err.response.data)
    })
  })
}





// 找對應 timzone 的 label_id
function findLabelID (timzone){
  return new Promise((resolve, reject) => {
    const query = `select * from labels where label_name = 'timezone${timzone}'`
    db.query(query, (err, result) => {
      if(err){
        return reject(err)
      }
      console.log(result,'result')
      return resolve(result)
    })
  })
}