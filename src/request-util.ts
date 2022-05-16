import {IResponseInfo} from "./index";

/**
 * @desc
 *
 * @使用场景
 *
 * @coder.yang2010@gmail.com
 * @Date    2022/5/16
 **/

export function getReponseId(response:IResponseInfo){

  if(['Document','Stylesheet','Image','Media','Font'].includes(response.type)){
    return response.response.url;
  }else if(response.type==='XHR'){
    return response.response.url+'-'+response.response.requestId;
  }else{
    return response.response.url;
  }

}
