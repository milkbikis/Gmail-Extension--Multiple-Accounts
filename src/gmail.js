// Simple API for reading from gmail feeds
var instanceId = 'gmc' + parseInt(Date.now() * Math.random(), 10);
var requestTimeout = 1000 * 2;  // 2 seconds

function gmailNSResolver(prefix) {
  if(prefix == 'gmail') {
    return 'http://purl.org/atom/ns#';
  }
}

function getGmailUrl(account) {
  var url = "https://mail.google.com/";
  if(account && account.domain)
    url += account.domain + '/';
  else
    url += 'mail/';
  return url;
}

function getAccountUrl(account) {
  return getGmailUrl(account) + 'u/' + account.number + '/';
}

function getInboxUrl(account) {
	return getAccountUrl(account) + '#inbox';
}

function getFeedUrl(account) {
  // "zx" is a Gmail query parameter that is expected to contain a random
  // string and may be ignored/stripped.
  return getAccountUrl(account) + "feed/atom?zx=" + encodeURIComponent(instanceId);
}

function getHTMLModeUrl(account) {
  return getAccountUrl(account) + 'h/' + Math.ceil(Math.random() * 1000000000).toString(16) + '/';
}

function isGmailUrl(url) {
  var gmail = getGmailUrl();
  return (url.indexOf(gmail) == 0);
}

function isAccountUrl(account, url) {
  // This is the Gmail we're looking for if:
  // - starts with the correct gmail url
  // - doesn't contain any other path chars
  var gmail = getAccountUrl(account);
  if (url.indexOf(gmail) != 0)
    return false;

  return url.length == gmail.length || url[gmail.length] == '?' ||
    url[gmail.length] == '#';
}

function parseAccountFeed(account, xmlHandler, onSuccess, onError) {
  var xhr = new XMLHttpRequest();
  var abortTimerId = window.setTimeout(function() {
    xhr.abort();  // synchronously calls onreadystatechange
  }, requestTimeout);

  function handleSuccess(data) {
    account.requestFailureCount = 0;
    window.clearTimeout(abortTimerId);
    if (onSuccess)
      onSuccess(account, data);
  }

  var invokedErrorCallback = false;
  function handleError() {
    ++account.requestFailureCount;
    window.clearTimeout(abortTimerId);
    if (onError && !invokedErrorCallback)
      onError(account);
    invokedErrorCallback = true;
  }

  try {
    xhr.onreadystatechange = function(){
      if (xhr.readyState != 4)
        return;

      if (xhr.responseXML) {
        var data = xmlHandler(xhr.responseXML);

        if(data) {
          handleSuccess(data);
          return;
        } else {
          console.error("Empty XHR response");
        }
      }

      // Authorization required
      if (xhr.status == 401)
        console.error("Authorization required");

      handleError();
    }

    xhr.onerror = function(error) {
      handleError();
    }

    if(account.user && account.pass)
      xhr.open("GET", getFeedUrl(account), true, account.user, account.pass);
    else
      xhr.open("GET", getFeedUrl(account), true);
    xhr.send(null);
  } catch(e) {
    console.error(e);
    handleError();
  }
}

function getAccountAt(account, onSuccess) {
  var url = getHTMLModeUrl(account);// + "?ui=html&zy=c";
  var xhr = new XMLHttpRequest();
  xhr.onreadystatechange = function () {
    if (this.readyState == 4 && this.status == 200) {
      var m = this.responseText.match(/\at=([^"]+)/);
      if (m && m.length > 0) {
        account.at = m[1];
        onSuccess();
      }
    }
  }
  xhr.onerror = function (error) {
    console.error("getAccountAt error: " + error);
  }
  xhr.open("GET", url, true);
  xhr.send(null);
}

function doAjaxRequest(url, onSuccess, onError, params, headers) {
  try {
    var xhr = new XMLHttpRequest();

    xhr.onreadystatechange = function () {
      if (this.readyState == 4) {
        if(this.status == 200) {
          if(onSuccess) {
            onSuccess(this.responseText);
          }
        } else if(this.status == 401) {
          console.error(chrome.i18n.getMessage("gmailcheck_auth_reqd"));
        } else {
          console.error("doAjaxRequest: response " + this.status);
          if(onError)
            onError();
        }
      }
    }

    xhr.onerror = function(e) {
      console.error("doAjaxRequest: " + e);
      if(onError)
        onError();
    }
    
    xhr.open("POST", url, true);
    for(key in headers)
      xhr.setRequestHeader(key, headers[key]);
    xhr.send(params);
  } catch(e) {
    console.error("doAjaxRequest exception: " + e);
    if(onError)
      onError();
  }

  return xhr;
}

function doGmailAction(account, msgID, action, onSuccess, onError) {
  if(!account.at) {
    getAccountAt(account, function() {
      doGmailAction(account, msgID, action, onSuccess, onError);
    });
    return;
  }

  var url = getHTMLModeUrl(account);
  var params = "t=" + msgID + "&at=" + account.at + "&act=" + action;

  return doAjaxRequest(url, onSuccess, onError, params, {"Content-type": "application/x-www-form-urlencoded"});
}

function doGmailReply(account, msgID, body, replyAll, onSuccess, onError) {
  /*
  https://mail.google.com/mail/u/0/h/4kanhx7cv3es/?&v=b&qrt=n&fv=cv&rm=13bf71c4f82c2c39&at=AF6bupM-wmLVbDy8fSwaTVkmeLBMqZYufA&pv=cv&th=13bf71c4f82c2c39&cs=qfnq
  POST params: qrr=o&body=Hello&nvp_bu_send=Send&haot=qt 
*/

  if(!account.at) {
    getAccountAt(account, function() {
      doGmailReply(account, msgID, body, replyAll, onSuccess, onError);
    });
    return;
  }

  var url = getHTMLModeUrl(account) + '?v=b&qrt=n&fv=cv&rm=' + msgID
      + '&at=' + account.at + '&cs=qfnq';
  var encodedBody = encodeURIComponent(body).replace(/%20/g, '+');
  var params = "body=" + encodedBody + "&nvp_bu_send=Send&haot=qt" +
    ("&qrr=" + (replyAll ? "a" : "o"));

  return doAjaxRequest(url, onSuccess, onError, params,
      {"Content-type": "application/x-www-form-urlencoded"});
}

function makeMessageSummary(message) {
  var div = document.createElement('DIV');
  div.innerHTML = message.body;
  return div.innerText.trim().substr(0, 100);
}

function makeMessage(messageTable, mailURL) {
  var nodes = messageTable.childNodes;
  for (var i = 0; i < nodes.length; ++i) {
    if (nodes[i].tagName == "TBODY") {
      rows = nodes[i].childNodes;
      break;
    }
  }

  var message = {};

  cells = [];
  for (var j = 0; j < 3; ++j) {
    nodes = rows[j].childNodes;
    for (var i = 0; i < nodes.length; ++i) {
      if (nodes[i].tagName == "TD")
        cells.push(nodes[i]);
    }
  }

  message.from = cells[0].innerText.replace(/\n/g,'');
  message.date = cells[1].innerText.replace(/\n/g, '');

  message.to = "";
  var div = cells[2].firstElementChild.firstElementChild;
  while (div) {
    var contacts = U.extractContacts(div.innerText.replace(/\n/g, ''));
    console.dir(contacts);
    var prefix = contacts[0];
    contacts = contacts[1];
    message.to += "<span class='contact-list' prefix='" + prefix + "'>";
    for (var i = 0; i < contacts.length; ++i) {
      message.to +=
        "<a class='contact-name' email ='" + contacts[i][1] + "'>" +
          U.HTMLEncode(contacts[i][0]) +
          ((i < contacts.length-1) ? ', ' : '') + 
        "</a>";
    }
    message.to += "</span>";
    div = div.nextElementSibling;
  }

  message.body = cleanBody(cells[3]);
  message.summary = makeMessageSummary(message);

  return message;
}

function cleanBody(body, mailURL) {

  return body.innerHTML
  //  .replace(/<tr>[\s\S]*?<tr>/, "")
  //  .replace(/<td colspan="?2"?>[\s\S]*?<td colspan="?2"?>/, "")
  //  .replace(/cellpadding="?12"?/g, "")
    .replace(/font size="?-1"?/g, 'font')
    .replace(/(href="?)\/mail\//g, "$1" + mailURL)
    .replace(/(src="?)\/mail\//g, "$1" + mailURL);
}

function fetchEmailMessages(account, msgID, onSuccess, onError) {
  var mailURL = getAccountUrl(account);
  var url = mailURL + "h/" + Math.ceil(1000000 * Math.random())
            + "/?v=pt&th=" + msgID;

  return doAjaxRequest(url, function (responseText) {
    var div = document.createElement('div');
    div.innerHTML = responseText;

    var messageTables = div.querySelectorAll('.message');

    if (messageTables) {
      var messages = [];
      for (var i = 0; i < messageTables.length; ++i) {
        messages.push(makeMessage(messageTables[i], mailURL));
      }
      onSuccess(messages);
    } else {
      onSuccess("<p><i>Could not parse this e-mail. Please use the <b>Open in Gmail</b> button below.</i></p>");
    }
  }, onError);
}

function saveToLocalStorage(domains) {
  var info = {};
  for(var domain in domains) {
    info[domain] = [];
    var accounts = accountInfo[domain];
    for(var i = 0; i < accounts.length; i++) {
      var account = accounts[i];
      info[domain][i] = {
        user: account.user,
        pass: account.pass,
        domain: domain,
        number: i
      }
    }
  }

  localStorage.accountInfo = JSON.stringify(info);
}
