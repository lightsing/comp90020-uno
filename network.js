// The public interface to the network layer of the system.
var Network = (function () {
  'use strict';

  // Decide which room to use based on the query string in the url.
  // ``` ?room=name querystring parameter ```
  // This allows multiple games to exist concurrently.
  var URL = window.location.href;
  var ROOM = 'comp90020-uno-' + (URL.indexOf('room') > 0 ?
                                 URL.substr(URL.indexOf('room') + 5) :
                                 'everyone');

  // ==== Message types

  // Network initialisation messages
  var READY          = 'READY';
  var INITIALISE     = 'INITIALISE';
  var PREINITIALISED = 'PREINITIALISED';

  // Ring mutex (turn taking) messages
  var TOPOLOGY       = 'TOPOLOGY';
  var TURN           = 'TURN';

  // Application state messages
  var STATE          = 'STATE';
  var CARD_COUNT     = 'CARD_COUNT';
  var WIN            = 'win';

  // Failure detection and handling messages
  var CHECK          = 'CHECK';
  var ACKNOWLEDGE    = 'ACKNOWLEDGE';
  var NODE_FAIL      = 'NODE_FAIL';
  var NODE_REMOVE    = 'NODE_REMOVE';

  // Election messages
  var ELECTION       = 'ELECTION';
  var LEADER         = 'LEADER';

  // myPid uniquely identifies this process.
  var myPid;

  // Constants and state related to the topology.
  var TOPOLOGY_INTERVAL_MILLISECONDS = 1000;
  var FORWARD = 'fwrd';
  var BACKWARD = 'back';
  var direction = FORWARD;
  // The leader permanently holds the lock on the topology.
  var topology;
  var readySet = {};

  // Upper and lower bounds on neighbour check times
  var MAX_CHECK_INTERVAL = 10000;
  var MIN_CHECK_INTERVAL = 2000;
  // checkInterval = CHECK_FACTOR * lastResponseTime
  var CHECK_FACTOR       = 3;

  var CheckState =
    {
      neighbour:           null,
      checkInterval:       MAX_CHECK_INTERVAL,
      lastPingTime:        null,
      checkTimeoutHandler: null,
      failed:              {},
      responseReceived:    true,
    };

  // Returns true if the topologies have the same leader, players,
  // and order of the players in both directions.
  // Otherwise returns false.
  function topologiesAreEqual(a, b) {
    // If the toplogies have different leaders, they're different.
    if (a.leader !== b.leader) return false;

    // If the topologies have different players, they're different.
    var aPlayers = Object.keys(a[FORWARD]).sort();
    var bPlayers = Object.keys(b[FORWARD]).sort();
    if (aPlayers.length !== bPlayers.length) return false;
    for (var i in aPlayers) {
      if (aPlayers[i] !== bPlayers[i]) return false;
    }

    // If the topologies have different ring links, they're different.
    return aPlayers.every(function (p) {
      return (a[FORWARD][p] === b[FORWARD][p]) &&
        (a[BACKWARD][p] === b[FORWARD][p]);
    });
  }

  // Regenerate the topology and return it.
  // This generates the topology in both directions (which makes
  // 'reverse' card logic easier).
  // TODO update this to use manual registration with the leader rather
  // than getting a list of processes from webrtc.
  function generateTopology() {
    // TODO use manual registration rather than WebRTC's peers.
    var peers = webrtc.getPeers();
    var pids = [myPid].concat(peers.map(function (p) { return p.id; }));

    // TODO Set all PENDING processs to be LIVE.
    //      Processes may be either PENDING, LIVE, or DEAD.
    //      DEAD processes must register with the leader to become PENDING.
    //      On the leader's turn, PENDING processes become LIVE again.

    // Completely recalculate the topology.
    // TODO Optimise to only recalculate stuff that changes.

    var topology = { leader: myPid };

    // Create the 'forward' topology based on the peer list.
    topology[FORWARD] = {};
    pids.sort().forEach(function (pid, i) {
      var iNext = (i + 1 >= pids.length) ? 0 : i + 1;
      topology[FORWARD][pid] = pids[iNext];
    });

    // Create the 'backward' topology as the reverse of the
    // forwards topology.
    topology[BACKWARD] = {};
    for (var first in topology[FORWARD]) {
      var second = topology[FORWARD][first];
      topology[BACKWARD][second] = first;
    }

    Utility.assertSameItems(
        Object.keys(topology[FORWARD]), Object.keys(topology[BACKWARD]),
        'forwards and backwards topologies must have the same pids');

    return topology;
  }

  // Gets ready to start a new game by resetting some of the network variables
  function resetGame() {
    // wipe these variables
    isInitialised = false;
    readySet = {};
  }

  function render(topology) {
    RootComponent.setState({
      players: Object.keys(topology[FORWARD]),
      leader: topology.leader,
    });
  }

  var webrtc = new SimpleWebRTC({
    media: {
      video: false,
      audio: false,
    },
  });

  // ===== One-to-one connections =====
  //
  // pidMap is a map of process IDs (pids) to peers.
  //
  // The `createdPeer` is triggered:
  //
  // * when this process connects, for each other peer, and
  // * when a new peer connects to the network after this peer.
  //
  // This is promised by the SimpleWebRTC API.
  //
  // The createdPeer event handle adds the new peer to pidMap, defined above.
  // The sendToPid function sends a message:
  //
  // * to the peer with the specified pid (`targetPid`),
  // * in the specified `room`,
  // * with the specified message `type`,
  // * containing the specified content (`message`).

  var pidMap = {};
  webrtc.on('createdPeer', function (peer) {
    pidMap[peer.id] = peer;

    // Before initialisation there is no leader, so each process
    // should compute and display its own player list.
    if (!isInitialised) {
      render(generateTopology());
    }
  });

  function sendToPid(targetPid, room, type, message) {
    Utility.log('Sending ' + type + ' to peer ' + targetPid);
    var peer = pidMap[targetPid];
    Utility.assert(peer !== undefined, 'target missing');
    peer.sendDirectly(room, type, message);
  }

  // TODO convert INITIALISE related logic into something better.
  var isInitialised = false;
  function initialise() {
    Utility.assert(!isInitialised, 'Network initialised twice');
    isInitialised = true;

    var peers = webrtc.getPeers();
    var pids = [myPid].concat(peers.map(function (p) { return p.id; }));
    Utility.log('Initial peer list is ' + pids.join(', '));

    // Choose the lowest myPid as the leader.
    Utility.log('My myPid is ' + myPid);
    var leader = pids.sort()[0];
    Utility.log('The leader is ' + leader);

    // Give the first turn to the leader.
    if (leader === myPid) {
      Utility.log("It's my turn first!");

      becomeLeader();

      Application.onFirstTurn(myPid);
    }

    onJoin();
  }

  function becomeLeader() {
    topology = generateTopology();
    broadcastTopology(topology);
  }

  webrtc.on('readyToCall', function () {
    myPid = webrtc.connection.connection.id;
    Utility.log('My myPid is ' + myPid);

    webrtc.joinRoom(ROOM);
    webrtc.sendDirectlyToAll(ROOM, READY);
    // TODO Replace dodgy busy wait with something good.

    webrtc.on('channelMessage', function (peer, room, data, other) {
      Utility.logMessage(peer, data.type, data.payload);

      // Ignore messages from failed processes.
      if (CheckState.failed[peer.id]) {
        Utility.log('Ignoring message from failed node ' + peer.id);
        return;
      }

      // Always acknowledge all non-ACKNOWLEDGE messages from known,
      // non-failed nodes.
      if (data.type !== ACKNOWLEDGE &&
          topology && topology[FORWARD][peer.id]) {
          sendToPid(peer.id, ROOM, ACKNOWLEDGE);
      }

      switch (data.type) {
        case TOPOLOGY:
          onTopologyUpdate(data.payload);
          break;

        case TURN:
          onTurnMessage(data.payload);
          break;

        case READY:
          if (isInitialised) {
            sendToPid(peer.id, ROOM, PREINITIALISED, topology);
          } else {
            readySet[peer.id] = true;
            console.log(readySet);

            // TODO don't cheat
            var peers = webrtc.getPeers();
            var pids =
              [myPid].concat(peers.map(function(p) { return p.id; }));
            var mayInitialise = pids.every(function(pid) {
              return readySet[pid];
            });
            if (mayInitialise) {
              initialise();
              Application.initialise();
              sendToPid(peer.id, ROOM, INITIALISE);
            }
          }
          break;

        case STATE:
          Application.onUpdate(data.payload);

          // in case we missed the initialise but joined the room since
          if (!isInitialised) {
            initialise();
            Application.initialise();
          }
          break;

        case INITIALISE:
          // TODO convert INITIALISE related logic into something better.
          if (isInitialised) break;
          initialise();
          Application.initialise();
          break;

        case PREINITIALISED:
          // TODO convert INITIALISE related logic into something better.
          if (!isInitialised) {
            isInitialised = true;
            onJoin();
            Application.initialise();
          }
          // TODO Register with the leader
          break;

        case CARD_COUNT:
          Application.onUpdateCardCount(peer.id, data.payload);
          break;

        case CHECK:
          // No special logic, just the ACKNOWLEDGE send from outside
          // the switch statement.
          break;

        case NODE_FAIL:
          if(myPid === topology.leader) {
            handleNodeFailure(peer.id, data.payload.failedPid, topology);
          }
          break;

        case NODE_REMOVE:
          CheckState.failed[data.payload.failedPid] = true;
          break;

        case ELECTION:
          // Propogate the election call if we haven't already.
          if (electionHandler === null) callElection(topology);
          break;

        case ACKNOWLEDGE:
          // TODO Remove the timeout for detection of the acknowledger
          // being dead.
          if (peer.id === CheckState.neighbour) {
            receiveNeighbourResponse(CheckState);
          }

          // If the sender has a higher pid than me, then don't win any
          // current election.
          if (peer.id > myPid) {
            clearTimeout(electionHandler);
            electionHandler = null;
          }
          break;

        case LEADER:
          // Set the new leader and clear both the short election
          // timeout and the long election timeout.
          topology.leader = peer;

          clearTimeout(electionHandler);
          electionHandler = null;
          clearTimeout(electionBackup);
          electionBackup = null;
          break;

        case WIN:
          // Similar to the state message, but mark us as uninitialised so we
          // can start the next game
          Application.onUpdate(data.payload);
          Application.onSomoneWon(peer.id);

          // mark us as uninitialised
          resetGame();
          break;

        default:
          throw 'incomplete branch coverage in message handler ' +
            'switch statement: ' + data.type;
      }
    });
  });

  // Called when the player readies up.
  function readyUp() {
    readySet[myPid] = true;
    // TODO convert INITIALISE related logic into something better.
    var peers = webrtc.getPeers();
    if (peers.length !== 0) {
      webrtc.sendDirectlyToAll(ROOM, READY);
    }
  }

  // === Topology functions ===
  //
  // The game uses a ring based topology for turn taking,
  // and broadcasts for sharing state.
  // The group of processes to receive broadcasts is automatically
  // managed by WebRTC.
  // The ring topology is managed by our code.
  //
  // The approach to the ring topology is to manage it with a
  // specific 'leader' process.
  // The leader process is the live process who is earliest in the
  // topology.
  //
  // A process may be in one of three states:
  //
  // A live process is one which is participating correctly in the
  // turn order.
  // A dead process is one which was previously live, but has either
  // crashed or lost contact with the other processs.
  // A pending process is one which is operating correctly and in
  // contact with the other processs, but is not yet participating in
  // the turn order.
  //
  // The leader is responsible for adding new processs to the
  // topology.
  // New processs are added at the end of the ring, and are initially
  // pending.
  // When the leader takes their turn, they change all pending
  // processs into live processs.
  //
  // When the leader dies, the first process to detect it should call
  // an election.
  // A new leader should be elected via either the ring based
  // algorithm or a more advanced algorithm; to be determined.

  // Called when this process joins an existing game.
  function onJoin() {
    console.log('topology on join: ' + topology);
    // All processes should periodically check on the topology
    // if they are the leader.
    window.setInterval(function () {
      if (topology.leader === myPid) checkTopology();
    }, TOPOLOGY_INTERVAL_MILLISECONDS);
  }

  // Called at the leader process when a processs tries to join.
  function onJoinRequest() {
    // TODO
    // 1. Add the new process to the topology, as pending.
    // 2. Broadcast the new topology.
  }

  // If this process is the current leader, recomputes the topology.
  // If it has changed, the view is updated accordingly and everyone
  // is notified.
  function checkTopology() {
    Utility.assertEquals(topology.leader, myPid,
        'only the leader may check the topology');
    Utility.log("Checking the topology since I'm the leader");

    // 1. Generate the new topology.
    var newTopology = generateTopology();

    // 2. Remember and broadcast the new topology if it is different.
    if (!topologiesAreEqual(newTopology, topology)) {
      topology = newTopology;
      render(newTopology);
      broadcastTopology(newTopology);
    }
  }

  function broadcastTopology(topology) {
    webrtc.sendDirectlyToAll(ROOM, TOPOLOGY, topology);
  }

  function broadcastState(newState) {
    webrtc.sendDirectlyToAll(ROOM, STATE, newState);
  }

  function broadcastCardCount(myCardCount) {
    webrtc.sendDirectlyToAll(ROOM, CARD_COUNT, myCardCount);
  }

  function broadcastWin(GameState) {
    // Reset the network variables for a new game
    resetGame();

    // update everyone else
    webrtc.sendDirectlyToAll(ROOM, WIN, GameState);
  }

  // Called when a process receives a topology update.
  function onTopologyUpdate(newTopology) {
    console.log('got topology ' + newTopology);
    // 1. Remember the topology.
    topology = newTopology;

    Utility.logTopology(topology, [FORWARD, BACKWARD]);

    Utility.assert(topology[FORWARD][myPid] !== undefined,
           'I have no neighbour!');

    beginNeighbourChecking(CheckState, topology[FORWARD][myPid]);

    Utility.log('The leader is now ' + topology.leader);

    // 2. Update the state of the view by adding on the list of
    // players from the topology
    render(topology);
  }

  // === Turn and state functions ===
  //
  // The approach here is to use a ring based mutex algorithm for
  // turn taking.
  //
  // All game state is considered to be locked by whichever
  // process is currently taking a turn.
  //
  // The game state includes:
  //
  // * The number of cards in each player's hand;
  //   but not the specific cards.
  // * The top card on the discard pile.
  // * The 'Uno list', a list of players who have one card
  //   left but haven't yet called Uno, so are vulnerable to
  //   a Gotcha call.

  function onTurnMessage(payload) {
    var newState = payload.newState;
    var turnType = payload.turnType;
    var nCardsToDraw = payload.nCardsToDraw;

    // Adhere to the direction which was passed to us.
    direction = payload.direction;

    if (!isInitialised) {
      endTurn(turnType, newState, nCardsToDraw);
      return;
    }

    // Accept the new turn.
    newState.turnOwner = myPid;

    // Draw cards if we're told to.
    if (nCardsToDraw) {
      Application.draw(nCardsToDraw);
      // TODO update our card count in `newState`.
    }

    // Update our local state and broadcast, after we updated
    // it with any card-draws we had to do.
    Application.onUpdate(newState);
    broadcastState(newState);

    // If we got skipped, give the turn to the next person,
    // otherwise take our turn.
    switch (turnType) {
      case TurnType.SKIP:
        endTurn(TurnType.NORMAL, newState);
        break;

      case TurnType.NORMAL:
        Application.onTurnReceived();
        break;

      // Note: REVERSE turn messages shouldn't actually be sent,
      // they should be converted to NORMAL messages with the direction
      // flipped.
      default:
        throw "Unknown turn type";
    }
  }

  // Ends the current player's turn, checks the topology to find
  // the next player, then sends the turn to the next player.
  function endTurn(turnType, newState, nCardsToDraw) {
    Utility.assert(newState.turnOwner === myPid,
        "tried to take a turn when it's not our turn");

    // Flip the turn direction if this is a reverse turn.
    var newDirection;
    if (turnType === TurnType.REVERSE) {
      turnType = TurnType.NORMAL;
      newDirection = (direction === FORWARD) ? BACKWARD : FORWARD;
    } else {
      newDirection = direction;
    }
    passTurn(turnType, newDirection, newState, nCardsToDraw);
  }

  function passTurn(turnType, newDirection, newState, nCardsToDraw) {
    var nextPlayer = topology[newDirection][myPid];
    sendToPid(nextPlayer, ROOM, TURN, {
      turnType: turnType,
      newState: newState,
      direction: newDirection,
      nCardsToDraw: nCardsToDraw,
    });
  }

  // === TODO Failure handling functions ===
  //
  // Not sure what the approach is here.
  //
  // Maybe handle it with a decorator around SimpleWebRTC?

  // Start the checking after being given a topology
  function beginNeighbourChecking(checkState, newNeighbour) {
    if (checkState.checkTimeoutHandler !== null) {
      clearTimeout(checkState.checkTimeoutHandler);
    }
    checkState.neighbour = newNeighbour;
    checkState.responseReceived = true;
    checkNeighbour(checkState);
  }

  // Ping a neighbour and expect a response
  function checkNeighbour(checkState) {
    // Report node if they haven't responded since last ping
    if (!checkState.responseReceived) {
      reportNeighbourFailure(checkState, topology.leader);
      return;
    }

    // Set up the next receive
    checkState.responseReceived = false;
    checkState.lastPingTime = new Date();
    sendToPid(checkState.neighbour, ROOM, CHECK);

    // Set up next response check/ping
    checkState.checkTimeoutHandler = setTimeout(function () {
      checkNeighbour(checkState, topology.leader);
    }, checkState.checkInterval);
  }

  // Register a neighbour's response
  function receiveNeighbourResponse(checkState) {
    checkState.responseReceived = true;

    var newInterval = CHECK_FACTOR * (new Date() - checkState.lastPingTime);
    if (newInterval > MAX_CHECK_INTERVAL) {
      newInterval = MAX_CHECK_INTERVAL;
    }
    else if (newInterval < MIN_CHECK_INTERVAL) {
      newInterval = MIN_CHECK_INTERVAL;
    }
    checkState.checkInterval = newInterval;
  }

  // Tell the leader our neighbour has failed
  function reportNeighbourFailure(checkState, leaderPid) {
    Utility.log('*** NODE FAIL *** -- Neighbour ' +
        checkState.neighbour + ' has failed');

    // The leader is authorised to handle node failures directly.
    if (leaderPid === myPid) {
      handleNodeFailure(myPid, checkState.neighbour, topology);
      return;
    }

    // If the leader died, let everyone know they're dead,
    // and elect a new one.
    if (checkState.neighbour === leaderPid) {
      Utility.log("The leader has failed!");
      handleNodeFailure(checkState.neighbour, topology);
      callElection(topology);
      return;
    }

    // If we're not the leader, and the leader is alive, then we need
    // to tell the leader so they can handle it.
    // Broadcast it rather than sending directly in case the leader changes.
    webrtc.sendDirectlyToAll(ROOM, NODE_FAIL, {
      failedPid: checkState.neighbour
    });
  }

  // As the leader, deal with a failed node
  // This should close the ring over the failed node:
  //   2 -- 3          2 -- 3          2 -- 3
  //  /      \        /      \        /     |
  // 1        4  =>  1        X  =>  1      |
  //  \      /        \      /        \     |
  //   6 -- 5          6 -- 5          6 -- 5
  function handleNodeFailure(failedPid, topology) {
    Utility.log('*** FAILED NODE ***\n' +
          failedPid + ' has been reported as failed to the me');

    // Short circuit the dead node in the topology.
    var after  = topology[FORWARD][failedPid];
    var before = topology[BACKWARD][failedPid];
    topology[FORWARD][before] = after;
    topology[BACKWARD][after] = before;

    // Remove the dead node from the topology.
    delete topology[FORWARD][failedPid];
    delete topology[BACKWARD][failedPid];

    // Render and broadcast the topology.
    broadcastTopology(topology);
    render(topology);

    // Register the node as dead and inform everyone that it is dead.
    CheckState.failed[failedPid] = true;
    webrtc.sendDirectlyToAll(ROOM, NODE_REMOVE, { failedPid: failedPid });
  }

  // ==== Leader failure handling.
  //
  // When the leader fails, we obviously can't just tell the leader
  // to restitch the ring, so we need a new strategy.
  //
  // The strategy must be an election for a new leader, since we must
  // always have a leader.
  // This new leader will be responsible for restitching the ring after
  // the election.
  //
  // Nodes dying won't kill the turn taking ring, since the leader will
  // save us.
  // We don't have a leader to save us during the election though,
  // so we can't just reuse our turn-taking ring for a ring based
  // election algorithm.
  //
  // Therefore we use the next most obvious and easy option;
  // the bully algorithm.

  // By default, we're not in an election.
  var electionHandler = null;
  var electionBackup = null

  var ELECTION_DURATION = MAX_CHECK_INTERVAL;

  function callElection(topology) {
    // 1. The election caller contacts all processes who would get priority
    // over the caller when selecting a leader.
    // If there are no such processes, instantly win the election.
    var higherPids =
      Object.keys(topology[FORWARD])
            .filter(function (pid) { return pid > myPid; });
    if (higherPids.length === 0) {
      winElection();
      return;
    }
    higherPids.forEach(function(pid) { sendToPid(pid, ROOM, ELECTION); });

    // Note: for the event handlers, keep the `newElectionHandler` and
    // `newElectionBackup` reference in their own closures so that
    // it can verify that a second election hasn't been called with dodgy
    // message and event ordering in Internet Explorer.

    // 2. If the election caller has no responses after a timeout,
    // they win the election.
    var newElectionHandler = setTimeout(function () {
      if (electionHandler === newElectionHandler) {
        winElection();
      }
    }, ELECTION_DURATION);
    electionHandler = newElectionHandler;

    // 3. If no leader is selected after a longer timeout, then the
    // caller wins the election, even if a higher PID already responded.
    // The longer timeout should allow time for a complete election
    // called by every process with a higher id.
    var newElectionBackup = setTimeout(function () {
      if (electionBackup === newElectionBackup) {
        winElection();
      }
    }, higherPids.length * ELECTION_DURATION);
    electionBackup = newElectionBackup;
  }

  // Win the election by announcing that this process is the new leader.
  function winElection() {
    webrtc.sendDirectlyToAll(ROOM, LEADER);
    becomeLeader();
  }

  return {
    endTurn: endTurn,
    readyUp: readyUp,
    sendToPid: sendToPid,
    broadcastState: broadcastState,
    broadcastCardCount: broadcastCardCount,
    broadcastWin: broadcastWin,
    get players() {
      // return the forward format of the topology
      if (topology) {
        return Object.keys(topology[FORWARD]);
      } else {
        return [];
      }
    },
    get myId() {
      return myPid;
    },
  };
})();
