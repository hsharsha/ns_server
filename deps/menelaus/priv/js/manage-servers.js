var ServersSection = {
  hostnameComparator: mkComparatorByProp('hostname'),
  pendingEject: [], // nodes to eject on next rebalance
  pending: [], // nodes for pending tab
  active: [], // nodes for active tab
  allNodes: [], // all known nodes

  visitTab: function (tabName) {
    if (ThePage.currentSection != 'servers') {
      $('html, body').animate({scrollTop: 0}, 250);
    }
    ThePage.ensureSection('servers');
    this.tabs.setValue(tabName);
  },
  updateData: function () {
    var self = this;
    var serversValue = self.serversCell.value || {};

    _.each("pendingEject pending active allNodes".split(' '), function (attr) {
      self[attr] = serversValue[attr] || [];
    });
  },
  renderEverything: function () {
    this.detailsWidget.prepareDrawing();

    var details = this.poolDetails.value;
    var rebalancing = details && details.rebalanceStatus != 'none';

    var pending = this.pending;
    var active = this.active;

    this.serversQ.find('.add_button').toggle(!!(details && !rebalancing));
    this.serversQ.find('.stop_rebalance_button').toggle(!!rebalancing);

    var mayRebalance = !rebalancing && pending.length !=0;

    if (details && !rebalancing && !details.balanced)
      mayRebalance = true;

    var unhealthyActive = _.detect(active, function (n) {
      return n.clusterMembership == 'active'
        && !n.pendingEject
        && n.status != 'healthy'
    })

    if (unhealthyActive)
      mayRebalance = false;

    var rebalanceButton = this.serversQ.find('.rebalance_button').toggle(!!details);
    rebalanceButton.toggleClass('disabled', !mayRebalance);

    if (details && !rebalancing) {
      $('#rebalance_tab .alert_num span').text(pending.length);
      $('#rebalance_tab').toggleClass('alert_num_display', !!pending.length);
    } else {
      $('#rebalance_tab').toggleClass('alert_num_display', false);
    }

    this.serversQ.toggleClass('rebalancing', !!rebalancing);

    if (!details)
      return;

    if (rebalancing) {
      renderTemplate('manage_server_list', [], $i('pending_server_list_container'));
      return this.renderRebalance(details);
    }

    if (active.length) {
      renderTemplate('manage_server_list', active, $i('active_server_list_container'));
      renderTemplate('manage_server_list', pending, $i('pending_server_list_container'));
    }

    $('#active_server_list_container .last-active').find('.eject_server').addClass('disabled').end()
      .find('.failover_server').addClass('disabled');

    $('#active_server_list_container .server_down .eject_server').addClass('disabled');
    $('.failed_over .eject_server, .failed_over .failover_server').hide();
  },
  renderServerDetails: function (item) {
    return this.detailsWidget.renderItemDetails(item);
  },
  renderRebalance: function (details) {
    var progress = this.rebalanceProgress.value;
    if (!progress) {
      progress = {};
    }
    nodes = _.clone(details.nodes);
    nodes.sort(this.hostnameComparator);
    var emptyProgress = {progress: 0};
    _.each(nodes, function (n) {
      var p = progress[n.otpNode];
      if (!p)
        p = emptyProgress;
      n.progress = p.progress;
      n.percent = truncateTo3Digits(n.progress * 100);
    });

    renderTemplate('rebalancing_list', nodes);
  },
  refreshEverything: function () {
    this.updateData();
    this.renderEverything();
  },
  onRebalanceProgress: function () {
    var value = this.rebalanceProgress.value;
    console.log("got progress: ", value);
    if (value.status == 'none') {
      this.poolDetails.invalidate();
      this.rebalanceProgressIsInteresting.setValue(false);
      if (value.errorMessage) {
        displayNotice(value.errorMessage, true);
      }
      return
    }

    this.renderRebalance(this.poolDetails.value);
    this.rebalanceProgress.recalculateAfterDelay(250);
  },
  init: function () {
    var self = this;

    self.poolDetails = DAO.cells.currentPoolDetailsCell;

    self.tabs = new TabsCell("serversTab",
                             "#servers .tabs",
                             "#servers .panes > div",
                             ["active", "pending"]);

    var detailsWidget = self.detailsWidget = new MultiDrawersWidget({
      hashFragmentParam: 'openedServers',
      template: 'server_details',
      elementKey: 'otpNode',
      placeholderCSS: '#servers .settings-placeholder',
      actionLink: 'openServer',
      actionLinkCallback: function () {
        ThePage.ensureSection('servers');
      },
      uriExtractor: function (nodeInfo) {
        return "/nodes/" + encodeURIComponent(nodeInfo.otpNode);
      },
      valueTransformer: function (nodeInfo, nodeSettings) {
        return _.extend({}, nodeInfo, nodeSettings);
      },
      listCell: Cell.compute(function (v) {return v.need(DAO.cells.serversCell).active})
    });

    self.serversCell = DAO.cells.serversCell;

    self.poolDetails.subscribeValue(function (poolDetails) {
      $($.makeArray($('#servers .failover_warning')).slice(1)).remove();
      var warning = $('#servers .failover_warning');

      if (!poolDetails || poolDetails.rebalanceStatus != 'none') {
        return;
      }

      function showWarning(text) {
        warning.after(warning.clone().show().find('.warning-text').text(text).end());
      }

      _.each(poolDetails.failoverWarnings, function (failoverWarning) {
        switch (failoverWarning) {
        case 'failoverNeeded':
          break;
        case 'rebalanceNeeded':
          showWarning('Rebalance required, some data is not currently replicated!');
          break;
        case 'hardNodesNeeded':
          showWarning('At least two servers are required to provide replication!');
          break;
        case 'softNodesNeeded':
          showWarning('Additional active servers required to provide the desired number of replicas!');
          break;
        case 'softRebalanceNeeded':
          showWarning('Rebalance recommended, some data does not have the desired number of replicas!');
          break;
        default:
          console.log('Got unknown failover warning: ' + failoverSafety);
        }
      });
    });

    self.serversCell.subscribeAny($m(self, "refreshEverything"));
    prepareTemplateForCell('active_server_list', self.serversCell);
    prepareTemplateForCell('pending_server_list', self.serversCell);

    var serversQ = self.serversQ = $('#servers');

    serversQ.find('.rebalance_button').live('click', self.accountForDisabled($m(self, 'onRebalance')));
    serversQ.find('.add_button').live('click', $m(self, 'onAdd'));
    serversQ.find('.stop_rebalance_button').live('click', $m(self, 'onStopRebalance'));

    function mkServerRowHandler(handler) {
      return function (e) {
        var serverRow = $(this).parents(".server_row").get(0) || $(this).parents('.add_back_row').get(0);
        var serverInfo = $.data(serverRow, 'server');
        return handler.call(this, e, serverInfo);
      }
    }

    function mkServerAction(handler) {
      return ServersSection.accountForDisabled(mkServerRowHandler(function (e, serverRow) {
        e.preventDefault();
        return handler(serverRow.hostname);
      }));
    }

    serversQ.find('.re_add_button').live('click', mkServerAction($m(self, 'reAddNode')));
    serversQ.find('.eject_server').live('click', mkServerAction($m(self, 'ejectNode')));
    serversQ.find('.failover_server').live('click', mkServerAction($m(self, 'failoverNode')));
    serversQ.find('.remove_from_list').live('click', mkServerAction($m(self, 'removeFromList')));

    self.rebalanceProgressIsInteresting = new Cell();
    self.rebalanceProgressIsInteresting.setValue(false);
    self.poolDetails.subscribeValue(function (poolDetails) {
      if (poolDetails && poolDetails.rebalanceStatus != 'none')
        self.rebalanceProgressIsInteresting.setValue(true);
    });

    // TODO: should we ignore errors here ?
    this.rebalanceProgress = new Cell(function (interesting, poolDetails) {
      if (!interesting)
        return;
      return future.get({url: poolDetails.rebalanceProgressUri});
    }, {interesting: self.rebalanceProgressIsInteresting,
        poolDetails: self.poolDetails});
    self.rebalanceProgress.keepValueDuringAsync = true;
    self.rebalanceProgress.subscribe($m(self, 'onRebalanceProgress'));
  },
  accountForDisabled: function (handler) {
    return function (e) {
      if ($(e.currentTarget).hasClass('disabled')) {
        e.preventDefault();
        return;
      }
      return handler.call(this, e);
    }
  },
  renderUsage: function (e, totals, withQuotaTotal) {
    var options = {
      topAttrs: {'class': "usage-block"},
      topRight: ['Total', ViewHelpers.formatMemSize(totals.total)],
      items: [
        {name: 'In Use',
         value: totals.usedByData,
         attrs: {style: "background-position:0 -15px;"},
         tdAttrs: {style: "color:#1878A2;"}
        },
        {name: 'Other Data',
         value: totals.used - totals.usedByData,
         attrs: {style: "background-position:0 -30px;"},
         tdAttrs: {style: "color:#C19710;"}},
        {name: 'Free',
         value: totals.total - totals.used}
      ],
      markers: []
    };
    if (withQuotaTotal) {
      options.topLeft = ['Membase Quota', ViewHelpers.formatMemSize(totals.quotaTotal)];
      options.markers.push({value: totals.quotaTotal,
                            attrs: {style: "background-color:#E43A1B;"}});
    }
    $(e).replaceWith(memorySizesGaugeHTML(options));
  },
  onEnter: function () {
    // we need this 'cause switchSection clears rebalancing class
    this.refreshEverything();
  },
  navClick: function () {
    this.onLeave();
    this.onEnter();
  },
  onLeave: function () {
    this.detailsWidget.reset();
  },
  onRebalance: function () {
    var self = this;
    self.postAndReload(self.poolDetails.value.controllers.rebalance.uri,
                       {knownNodes: _.pluck(self.allNodes, 'otpNode').join(','),
                        ejectedNodes: _.pluck(self.pendingEject, 'otpNode').join(',')});
    self.poolDetails.getValue(function () {
      // switch to active server tab when poolDetails reload is complete
      self.tabs.setValue("active");
    });
  },
  onStopRebalance: function () {
    this.postAndReload(this.poolDetails.value.stopRebalanceUri, "");
  },
  validateJoinClusterParams: function (form) {
    var data = {}
    _.each("hostname user password".split(' '), function (name) {
      data[name] = form.find('[name=' + name + ']').val();
    });

    var errors = [];

    if (data['hostname'] == "")
      errors.push("Server IP Address cannot be blank.");
    if (!data['user'] || !data['password'])
      errors.push("Username and Password are both required to join a cluster.");

    if (!errors.length)
      return data;
    return errors;
  },
  onAdd: function () {
    var self = this;

    var dialog = $('#join_cluster_dialog');
    var form = dialog.find('form');
    $('#join_cluster_dialog_errors_container').empty();
    $('#join_cluster_dialog form').get(0).reset();
    dialog.find("input:not([type]), input[type=text], input[type=password]").val('');
    dialog.find('[name=user]').val('Administrator');

    $('#join_cluster_dialog_errors_container').empty();
    showDialog('join_cluster_dialog', {
      onHide: function () {
        form.unbind('submit');
      }});
    form.bind('submit', function (e) {
      e.preventDefault();

      var errors = self.validateJoinClusterParams(form);
      if (errors.length) {
        renderTemplate('join_cluster_dialog_errors', errors);
        return;
      }

      var confirmed;

      $('#join_cluster_dialog').addClass('overlayed');
      showDialog('add_confirmation_dialog', {
        eventBindings: [['.save_button', 'click', function (e) {
          e.preventDefault();
          confirmed = true;
          hideDialog('add_confirmation_dialog');

          $('#join_cluster_dialog_errors_container').html('');
          var overlay = overlayWithSpinner(form);

          var uri = self.poolDetails.value.controllers.addNode.uri;
          self.poolDetails.setValue(undefined);

          postWithValidationErrors(uri, form, function (data, status) {
            self.poolDetails.invalidate();
            overlay.remove();
            if (status != 'success') {
              renderTemplate('join_cluster_dialog_errors', data)
            } else {
              hideDialog('join_cluster_dialog');
            }
          })
        }]],
        onHide: function () {
          $('#join_cluster_dialog').removeClass('overlayed');
          if (!confirmed)
            hideDialog('join_cluster_dialog'); // cancel pressed on confirmation dialog
        }
      });
    });
  },
  findNode: function (hostname) {
    return _.detect(this.allNodes, function (n) {
      return n.hostname == hostname;
    });
  },
  mustFindNode: function (hostname) {
    var rv = this.findNode(hostname);
    if (!rv) {
      throw new Error("failed to find node info for: " + hostname);
    }
    return rv;
  },
  reDraw: function () {
    this.serversCell.invalidate();
  },
  ejectNode: function (hostname) {
    var self = this;

    var node = self.mustFindNode(hostname);
    if (node.pendingEject)
      return;

    showDialogHijackingSave("eject_confirmation_dialog", ".save_button", function () {
      if (node.clusterMembership == 'inactiveAdded') {
        self.postAndReload(self.poolDetails.value.controllers.ejectNode.uri,
                           {otpNode: node.otpNode});
      } else {
        self.pendingEject.push(node);
        self.reDraw();
      }
    });
  },
  failoverNode: function (hostname) {
    var self = this;
    var node = self.mustFindNode(hostname);
    showDialogHijackingSave("failover_confirmation_dialog", ".save_button", function () {
      self.postAndReload(self.poolDetails.value.controllers.failOver.uri,
                         {otpNode: node.otpNode});
    });
  },
  reAddNode: function (hostname) {
    var node = this.mustFindNode(hostname);
    this.postAndReload(this.poolDetails.value.controllers.reAddNode.uri,
                       {otpNode: node.otpNode});
  },
  removeFromList: function (hostname) {
    var node = this.mustFindNode(hostname);

    if (node.pendingEject) {
      this.serversCell.cancelPendingEject(node);
      return;
    }

    var ejectNodeURI = this.poolDetails.value.controllers.ejectNode.uri;
    this.postAndReload(ejectNodeURI, {otpNode: node.otpNode});
  },
  postAndReload: function (uri, data) {
    var self = this;
    // keep poolDetails undefined for now
    self.poolDetails.setValue(undefined);
    postWithValidationErrors(uri, $.param(data), function (data, status) {
      // re-calc poolDetails according to it's formula
      self.poolDetails.invalidate();
      if (status == 'error' && data[0].mismatch) {
        self.poolDetails.changedSlot.subscribeOnce(function () {
          var msg = "Could not Rebalance because the cluster configuration was modified by someone else.\nYou may want to verify the latest cluster configuration and, if necessary, please retry a Rebalance."
          alert(msg);
        });
      }
    });
  },
  editServerSettings: function (otpNode) {
    var nodes = this.poolDetails.value.nodes;
    var node = _.detect(nodes, function (e) {return e.otpNode == otpNode});
    if (!node)
      return;

    var values = _.extend({}, node, node.detailsCell.value);
    values['directPort'] = values.ports.direct;
    values['proxyPort'] = values.ports.proxy;
    runFormDialog("/nodes/" + otpNode + "/controller/settings", 'edit_server_settings_dialog', {
      initialValues: values
    });
  }
};

configureActionHashParam('visitServersTab', $m(ServersSection, 'visitTab'));
