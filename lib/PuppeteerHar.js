const fs = require('fs');
const { promisify } = require('util');
const { harFromMessages } = require('chrome-har');

// event types to observe
const page_observe = [
  'Page.loadEventFired',
  'Page.domContentEventFired',
  'Page.frameStartedLoading',
  'Page.frameAttached',
  'Page.frameScheduledNavigation',
];

const network_observe = [
  'Network.requestWillBeSent',
  'Network.requestServedFromCache',
  'Network.dataReceived',
  'Network.responseReceived',
  'Network.resourceChangedPriority',
  'Network.loadingFinished',
  'Network.loadingFailed',
];

class PuppeteerHar {
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
   * @returns {void}
   */
  cleanUp() {
    this.network_events = [];
    this.page_events = [];
    this.response_body_promises = [];
  }

  staticData = {
    allCount: 0,
    sucessCount: 0,
    failCount: 0,
  };

  /**
   * @param {{path: string}=} options
   * @return {Promise<void>}
   */
  async start({ path, saveResponse, captureMimeTypes } = {}) {
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

    let responseMap = {};

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
              responseParams.response.body = new Buffer.from(
                responseBody.body,
                responseBody.base64Encoded ? 'base64' : undefined
              ).toString();
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

module.exports = PuppeteerHar;
