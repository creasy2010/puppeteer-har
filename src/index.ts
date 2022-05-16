import { harFromMessages } from 'chrome-har';
import * as fs from  'fs';
import  { promisify } from 'util';
import {CDPSession, Frame, Page} from "puppeteer";
import { getReponseId } from './request-util';

// event types to observe
const page_observe:string[] = [
  'Page.loadEventFired',
  'Page.domContentEventFired',
  'Page.frameStartedLoading',
  'Page.frameAttached',
  'Page.frameScheduledNavigation',
];

const network_observe:string[] = [
  'Network.requestWillBeSent',
  'Network.requestServedFromCache',
  'Network.dataReceived',
  'Network.responseReceived',
  'Network.resourceChangedPriority',
  'Network.loadingFinished',
  'Network.loadingFailed',
];

export default class PuppeteerHar {

  /**
   * 录制流量的页面;
   */
  page:Page;
  /**
   * 录制流量页面的mainFrame;
   */
  mainFrame:Frame;
  /**
   * 是否正在录制;
   */
  inProgress:boolean;

  //保存文件路径;
  path:string;

  /**
   * 是否保存返回数据内容;
   */
  saveResponse:boolean=false;
  /**
   * 记录所有devtool协议的内容;
   */
  network_events:any[];

  page_events:any[];
  /**
   * 等待查询
   */
  response_body_promises:any[]=[];

  /**
   * 捕获的资源类型;
   */
  captureMimeTypes:string[]=[];

  /**
   * CDP 客户端;
   */
  client:CDPSession;

  /**
   * @param {object} page
   */
  constructor(page) {
    this.page = page;
    this.mainFrame = this.page.mainFrame();
    this.inProgress = false;
    this.cleanUp();
  }

  /**
   * 重置清空;
   * @returns {void}
   */
  cleanUp() {
    this.network_events = [];
    this.page_events = [];
    this.response_body_promises = [];
  }

  /**
   * 捕获统计数据
   */
  staticData = {
    allCount: 0,
    sucessCount: 0,
    failCount: 0,
  };

  /**
   * @param {{path: string}=} options
   * @return {Promise<void>}
   */
  async start(param:{
    path:string;
    saveResponse?:boolean;
    captureMimeTypes:string[]
  }) {
    let { path, saveResponse, captureMimeTypes } =param;
    this.inProgress = true;
    this.saveResponse = saveResponse || false;
    this.captureMimeTypes = captureMimeTypes || [
      'text/html',
      'application/json',
    ];
    this.path = path;
    this.client = await this.page.target().createCDPSession();
    await this.client.send('Page.enable');
    await this.client.send('Network.enable');
    page_observe.forEach((method) => {
      this.client.on(method, (params) => {
        if (!this.inProgress) {
          return;
        }
        this.page_events.push({ method, params });
      });
    });

    let responseMap:{
      [requestId:string]:IResponseInfo;
    } = {};
    //内容与结果值缓存;
    let urlGetCheck=[];

    network_observe.forEach((method) => {
      this.client.on(method, (params) => {
        if (!this.inProgress) {
          return;
        }
        const { requestId } = params;
        this.network_events.push({ method, params });
        let tryCount = 3;

        let getResponse = (sucess) => {
          this.client.send('Network.getResponseBody', { requestId }).then(
            (responseBody) => {
              let responseParams = responseMap[requestId];
              this.staticData.sucessCount++;
              // console.log('获取content路径:',params.response && params.response.url);
              // Set the response so `chrome-har` can add it to the HAR
              if (!responseParams.response) {
                responseParams.response = {};
              }
              if (tryCount != 3) {
                console.log(
                  `${new Date().toLocaleTimeString()}::重试后获取content路径:requestId:${requestId}`,
                  responseParams.response && responseParams.response.url
                );
              }
              //@ts-ignore;
              responseParams.response.body = new Buffer.from(
                responseBody.body,
                responseBody.base64Encoded ? 'base64' : undefined
              ).toString();

              let responseId =   getReponseId(responseParams);
              if(urlGetCheck[responseId] ){
                if(urlGetCheck[responseId] !=responseParams.response.body ){
                  debugger;
                  console.warn(`${new Date().toLocaleTimeString()}::多次获取content内容不一致 :requestId:${requestId},url:${responseParams.response.url}`);
                }else{
                  responseParams.response.body=undefined;
                }
              }else{
                urlGetCheck[responseId] = responseParams.response.body;
              }
              sucess();
            },
            (reason) => {
              let responseParams = responseMap[requestId];
              sucess();
              if (tryCount-- > 0) {
                console.log(
                  `${new Date().toLocaleTimeString()}::获取content失败,重试[${tryCount}]:`,
                  responseParams.response && responseParams.response.url
                );
                setTimeout(() => {
                  getResponse(sucess);
                }, 500);
              } else {
                this.staticData.failCount++;
                console.error(
                  `${new Date().toLocaleTimeString()}::har get response failed 路径,requestId:${requestId}`,
                  responseParams.response && responseParams.response.url,
                  reason
                );
              }
              // Resources (i.e. response bodies) are flushed after page commits
              // navigation and we are no longer able to retrieve them. In this
              // case, fail soft so we still add the rest of the response to the
              // HAR. Possible option would be force wait before navigation...
            }
          );
        };
        if (this.saveResponse && method == 'Network.responseReceived') {
          const { requestId } = params;
          responseMap[requestId] = params;
          getResponse(() => {});
        }
        // if(method==='Network.dataReceived'){
        //     console.log( 'Network.dataReceived',params.requestId);
        // }
        //
        if (this.saveResponse && method == 'Network.loadingFinished') {
          //Network.dataReceived
          this.staticData.allCount++;
          let responseParams = responseMap[params.requestId];
          const response = responseParams.response;
          const requestId = responseParams.requestId;

          // console.log(`${new Date().toLocaleTimeString()}::Network.responseReceived`, requestId,responseParams.response && responseParams.response.url);

          // Response body is unavailable for redirects, no-content, image, audio and video responses
          if (
            true
            // response.status !== 204 &&
            // response.headers.location == null
            // &&
            // this.captureMimeTypes.includes(response.mimeType)
          ) {
            const promise = new Promise((resolve) => {
              getResponse(resolve);
            });
            this.response_body_promises.push(promise);
          }
        }
      });
    });
  }

  /**
   * @returns {Promise<void|object>}
   */
  async stop() {
    this.inProgress = false;
    await Promise.all(this.response_body_promises);
    console.log(
      `总请求书${this.staticData.allCount},成功请求数:${this.staticData.sucessCount},失败请求数:${this.staticData.failCount}`
    );
    this.staticData = {
      allCount: 0,
      sucessCount: 0,
      failCount: 0,
    };
    await this.client.detach();
    const har = harFromMessages(this.page_events.concat(this.network_events), {
      includeTextFromResponseBody: this.saveResponse,
    });

    this.cleanUp();
    if (this.path) {
      await promisify(fs.writeFile)(this.path, JSON.stringify(har));
    } else {
      return har;
    }
  }
}


export interface IResponseInfo{
  type?:"Document"|"Script"|"Stylesheet"|"Image"|"Media"|"Font"|"Other";
  loaderId?:string;
  timestamp?:number;
  hasExtraInfo?:boolean;
  frameId?:string;
  response:{
    requestId?:string;
    status?:number;
    headers?:any;
    mimeType?:string;
    body?:string;
    url?:string;
    [key:string]:any;
  };
  [key:string]:any;

}
