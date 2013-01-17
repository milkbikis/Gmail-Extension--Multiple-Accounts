(function (global) {
  'use strict';

  /*
   * Account represents a single mail account, such as banga@cs.unc.edu
   * It can read from multiple feeds, each for a different label
   */ 
  function Account(args) {
    this.domain = args.domain || 'mail';
    this.number = args.number || 0;
    this.labels = args.labels || [''];
    this.url = args.url ||
      (Account.GMAIL_URL + this.domain + '/u/' + this.number + '/');

    this.status = Account.STATUS_NONE;
    this.feedStatus = Account.FEED_STATUS_NONE;
    this.lastUpdated = {};
    this.conversations = {};
    this.unreadCount = 0;

    this._labelQueue = [];

    this.subscribe('init', function () {
      log.info('Account initialized:', this.url);
      this.status = Account.STATUS_INITIALIZED;
      this.update();
    }, this);

    this.subscribe('initFailed', function () {
      log.info('Account initialization failed:', this.url);
      this.status = Account.STATUS_INITIALIZATION_FAILED;
    }, this);

    this.subscribe('feedParsed', function () {
      log.info('Account feed parsed:', this.url);
      this.feedStatus = Account.FEED_STATUS_PARSED;
    }, this);

    this.subscribe('feedParseFailed', function () {
      log.info('Account feed parsing failed:', this.url);
      this.feedStatus = Account.FEED_STATUS_PARSE_FAILED;
    }, this);

    this.subscribe('conversationAdded', function (conversation) {
      log.info('Conversation added:', conversation.subject);
      ++this.unreadCount;
    }, this);

    this.subscribe('conversationDeleted', function (conversation) {
      log.info('Conversation deleted:', conversation.subject);
      --this.unreadCount;
    }, this);
  }

  $.addEventHandling(Account, [
      'init',           // We have everything needed to start fetching emails
      'initFailed',
      'feedParsed',
      'feedParseFailed',
      'conversationAdded',
      'conversationDeleted',
      'conversationUpdated',
      'conversationUpdateFailed'
    ]);

  Account.GMAIL_URL = 'https://mail.google.com/';
  Account.STATUS_NONE = 1;
  Account.STATUS_INITIALIZING = 2;
  Account.STATUS_INITIALIZED = 3;
  Account.STATUS_INITIALIZATION_FAILED = 4;
  Account.FEED_STATUS_NONE = 1;
  Account.FEED_STATUS_PARSING = 2;
  Account.FEED_STATUS_PARSED = 3;
  Account.FEED_STATUS_PARSE_FAILED = 4;

  Account.prototype.toJSON = function () {
    return {
      domain: this.domain,
      number: this.number,
      labels: this.labels,
      url:    this.url
    };
  };

  Account.isGmailURL = function (url) {
    return (url.indexOf(Account.GMAIL_URL) === 0);
  };

  Account.prototype.isAccountURL = function (url) {
    if (!url || url.indexOf(this.url) !== 0)
      return false;
    return url.length == this.url.length || url[this.url.length] == '?' ||
      url[this.url.length] == '#';
  };

  Account.prototype.htmlModeURL = function () {
    return this.url + 'h/' +
      Math.ceil(Math.random() * 1.5e17).toString(26) + '/';
  };

  Account.prototype.feedURL = function (label) {
    return this.url + 'feed/atom/' + label;
  };

  Account.prototype.init = function () {
    if (this.status == Account.STATUS_INITIALIZING) {
      return;
    }
    this.status = Account.STATUS_INITIALIZING;
    var that = this;
    var onSuccess = this.publish.bind(this, 'init', this);
    var onError = this.publish.bind(this, 'initFailed', this);
    this._fetchAccountURL(function () {
      that._fetchAccountAtParameter(onSuccess, onError);
    }, onError);
  };

  Account.prototype._fetchAccountURL = function (onSuccess, onError) {
    var that = this;

    $.post({
      url: this.url,
      onSuccess: function (xhr) {
        // Account's possibly redirected url
        var doc = $.make('document').html(xhr.response);
        var meta = doc.querySelector('meta[name="application-url"]');
        if (meta) {
          that.url = meta.getAttribute('content') + '/';
        }
        onSuccess();
      },
      onError: onError
    });
  };

  Account.prototype._fetchAccountAtParameter = function (onSuccess, onError) {
    var that = this;

    $.post({
      url: this.htmlModeURL(),
      onSuccess: function (xhr) {
        var m = xhr.responseText.match(/\at=([^"]+)/);
        if (m && m.length > 0) {
          that.at = m[1];
          onSuccess();
        } else {
          onError();
        }
      },
      onError: onError
    });
  };

  Account.prototype._processLabelQueue = function () {
    if (this._labelQueue.length) {
      this._parseFeed(
          this._labelQueue.pop(),
          this._processLabelQueue.bind(this),
          this.publish.bind(this, 'feedParseFailed', this));
    } else {
      // Finished parsing
      this.conversations.each(function (conversation, id) {
        if (!conversation.hasLabels()) {
          this.publish('conversationDeleted', conversation);
          delete this.conversations[id];
        } else {
          conversation.updateIfDirty();
        }
      }, this);
      this.publish('feedParsed');
    }
  };

  Account.prototype.update = function () {
    if (this.status === Account.STATUS_INITIALIZATING) {
      return;
    }

    if (this.status === Account.STATUS_INITIALIZATION_FAILED) {
      this.init();
      return;
    }

    if (this.feedStatus !== Account.FEED_STATUS_PARSING) {
      this.feedStatus = Account.FEED_STATUS_PARSING;
      this._labelQueue = this.labels.slice(0);
      this._processLabelQueue();
    }
  };

  Account.prototype._onFeed = function (label, onSuccess, onError, xhr) {
    var onConversationUpdated = this.publish.bind(this, 'conversationUpdated');
    var onConversationUpdateFailed =
      this.publish.bind(this, 'conversationUpdateFailed');

    var xmlDoc = xhr.responseXML;
    var fullCountNode = xmlDoc.querySelector('fullcount');

    if (fullCountNode) {
      var modifiedNode = xmlDoc.querySelector('modified');
      if (modifiedNode) {
        var modified = new Date(modifiedNode.textContent);
        var lastUpdated = this.lastUpdated[label] || new Date(0);
        if (modified <= lastUpdated) {
          // Feed is unmodified
          onSuccess();
          return;
        }
        this.lastUpdated[label] = modified;
      }

      var titleNode = xmlDoc.querySelector('title');

      if (titleNode) {
        this.name = /\S*@\S*/.exec(titleNode.textContent)[0];

        var entryNodes = xmlDoc.querySelectorAll('entry');

        if (entryNodes) {
          var msgIDs = {};
          entryNodes.each(function (entryNode, idx) {
            var newConversation = new Conversation(this, entryNode, idx); 
            var msgID = newConversation.id;
            msgIDs[msgID] = '';

            if (msgID in this.conversations) {
              // Update existing conversation
              var conversation = this.conversations[msgID];
              if (conversation.modified != newConversation.modified) {
                conversation.fromFeed(entryNode);
                conversation.markDirty();
              } else {
                conversation.addLabel(label);
              }
            } else {
              // New conversation
              newConversation.addLabel(label);
              newConversation.subscribe('updated', onConversationUpdated,
                this);
              newConversation.subscribe('updateFailed',
                onConversationUpdateFailed, this);
              this.conversations[msgID] = newConversation;
              this.publish('conversationAdded', newConversation);
            }
          }, this);

          this.conversations.each(function (conversation, id) {
            if (!(id in msgIDs)) {
              // Conversation is not in this label anymore
              conversation.removeLabel(label);
            }
          });
        }

        onSuccess();
        return;
      }
    }
    onError();
  };

  Account.prototype._parseFeed = function (label, onSuccess, onError) {
    $.get({
      url: this.feedURL(label),
      onSuccess: this._onFeed.bind(this, label, onSuccess, onError),
      onError: onError 
    });
  };

  Account.prototype.removeConversation = function (id) {
    this.publish('conversationDeleted', this.conversations[id]);
    delete this.conversations[id];
  };

  Account.prototype.detachView = function () {
    if (this.view) {
      this.conversations.each(function (conversation) {
        conversation.detachView();
      });
      this.view.onDetach();
      this.view = null;
    }
  };

  Account.prototype.attachView = function (view) {
    this.detachView();
    this.view = view;
  };

  Account.prototype.openInGmail = function () {
    var this_ = this;
    chrome.tabs.query({}, function (tabs) {
      var found = false;

      tabs.each(function (tab) {
        if (this_.isAccountURL(tab.url)) {
          chrome.tabs.update(tab.id, {selected: true});
          found = true;
          return false;
        }
      });

      if (!found) {
        chrome.tabs.create({url: this_.url});
      }
    });
  };

  global.Account = Account;
}) (window);
