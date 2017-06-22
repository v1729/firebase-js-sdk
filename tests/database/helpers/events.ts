import { EventAccumulator } from './EventAccumulator';
import { TEST_PROJECT } from "./util";

/**
 * A set of functions to clean up event handlers.
 * @type {function()}
 */
export let eventCleanupHandlers = [];


/** Clean up outstanding event handlers */
export function eventCleanup() {
  for (var i = 0; i < eventCleanupHandlers.length; ++i) {
    eventCleanupHandlers[i]();
  }
  eventCleanupHandlers = [];
};

/**
 * The path component of the firebaseRef url
 * @param {Firebase} firebaseRef
 * @return {string}
 */
function rawPath(firebaseRef) {
  return firebaseRef.toString().replace(TEST_PROJECT.databaseURL, '');
};

/**
 * Creates a struct which waits for many events.
 * @param {Array<Array>} pathAndEvents an array of tuples of [Firebase, [event type strings]]
 * @param {string=} opt_helperName
 * @return {{waiter: waiter, watchesInitializedWaiter: watchesInitializedWaiter, unregister: unregister, addExpectedEvents: addExpectedEvents}}
 */
export function eventTestHelper(pathAndEvents, helperName?) {
  var expectedPathAndEvents = [];
  var actualPathAndEvents = [];
  var pathEventListeners = {};
  var initializationEvents = 0;

  helperName = helperName ? helperName + ': ' : '';

  // Listen on all of the required paths, with a callback function that just
  // appends to actualPathAndEvents.
  var make_eventCallback = function(type) {
    return function(snap) {
      // Get the ref of where the snapshot came from.
      var ref = type === 'value' ? snap.ref : snap.ref.parent;

      actualPathAndEvents.push([rawPath(ref), [type, snap.key]]);

      if (!pathEventListeners[ref].initialized) {
        initializationEvents++;
        if (type === 'value') {
          pathEventListeners[ref].initialized = true;
        }
      } else {
        // Call waiter here to trigger exceptions when the event is fired, rather than later when the
        // test framework is calling the waiter...  makes for easier debugging.
        waiter();
      }
    };
  };

  // returns a function which indicates whether the events have been received
  // in the correct order.  If anything is wrong (too many events or
  // incorrect events, we throw).  Else we return false, indicating we should
  // keep waiting.
  var waiter = function() {
    var pathAndEventToString = function(pathAndEvent) {
      return '{path: ' + pathAndEvent[0] + ', event:[' + pathAndEvent[1][0] + ', ' + pathAndEvent[1][1] + ']}';
    };

    var i = 0;
    while (i < expectedPathAndEvents.length && i < actualPathAndEvents.length) {
      var expected = expectedPathAndEvents[i];
      var actual = actualPathAndEvents[i];

      if (expected[0] != actual[0] || expected[1][0] != actual[1][0] || expected[1][1] != actual[1][1]) {
        throw helperName + 'Event ' + i + ' incorrect. Expected: ' + pathAndEventToString(expected) +
            ' Actual: ' + pathAndEventToString(actual);
      }
      i++;
    }

    if (expectedPathAndEvents.length < actualPathAndEvents.length) {
      throw helperName + "Extra event detected '" + pathAndEventToString(actualPathAndEvents[i]) + "'.";
    }

    // If we haven't thrown and both arrays are the same length, then we're
    // done.
    return expectedPathAndEvents.length == actualPathAndEvents.length;
  };

  var listenOnPath = function(path) {
    var valueCB = make_eventCallback('value');
    var addedCB = make_eventCallback('child_added');
    var removedCB = make_eventCallback('child_removed');
    var movedCB = make_eventCallback('child_moved');
    var changedCB = make_eventCallback('child_changed');
    path.on('child_removed', removedCB);
    path.on('child_added', addedCB);
    path.on('child_moved', movedCB);
    path.on('child_changed', changedCB);
    path.on('value', valueCB);
    return function() {
      path.off('child_removed', removedCB);
      path.off('child_added', addedCB);
      path.off('child_moved', movedCB);
      path.off('child_changed', changedCB);
      path.off('value', valueCB);
    }
  };


  var addExpectedEvents = function(pathAndEvents) {
    var pathsToListenOn = [];
    for (var i = 0; i < pathAndEvents.length; i++) {

      var pathAndEvent = pathAndEvents[i];

      var path = pathAndEvent[0];
      //var event = pathAndEvent[1];

      pathsToListenOn.push(path);

      pathAndEvent[0] = rawPath(path);

      if (pathAndEvent[1][0] === 'value')
        pathAndEvent[1][1] = path.key;

      expectedPathAndEvents.push(pathAndEvent);
    }

    // There's some trickiness with event order depending on the order you attach event callbacks:
    //
    // When you listen on a/b/c, a/b, and a, we dedupe that to just listening on a.  But if you do it in that
    // order, we'll send "listen a/b/c, listen a/b, unlisten a/b/c, listen a, unlisten a/b" which will result in you
    // getting events something like "a/b/c: value, a/b: child_added c, a: child_added b, a/b: value, a: value"
    //
    // BUT, if all of the listens happen before you are connected to firebase (e.g. this is the first test you're
    // running), the dedupe will have taken affect and we'll just send "listen a", which results in:
    // "a/b/c: value, a/b: child_added c, a/b: value, a: child_added b, a: value"
    // Notice the 3rd and 4th events are swapped.
    // To mitigate this, we re-ordeer your event registrations and do them in order of shortest path to longest.

    pathsToListenOn.sort(function(a, b) { return a.toString().length - b.toString().length; });
    for (i = 0; i < pathsToListenOn.length; i++) {
      path = pathsToListenOn[i];
      if (!pathEventListeners[path.toString()]) {
        pathEventListeners[path.toString()] = { };
        pathEventListeners[path.toString()].initialized = false;
        pathEventListeners[path.toString()].unlisten = listenOnPath(path);
      }
    }
  };

  addExpectedEvents(pathAndEvents);

  var watchesInitializedWaiter = function() {
    for (var path in pathEventListeners) {
      if (!pathEventListeners[path].initialized)
        return false;
    }

    // Remove any initialization events.
    actualPathAndEvents.splice(actualPathAndEvents.length - initializationEvents, initializationEvents);
    initializationEvents = 0;

    return true;
  };

  var unregister = function() {
    for (var path in pathEventListeners) {
      if (pathEventListeners.hasOwnProperty(path)) {
        pathEventListeners[path].unlisten();
      }
    }
  };

  eventCleanupHandlers.push(unregister);
  return {
    waiter: waiter,
    watchesInitializedWaiter: watchesInitializedWaiter,
    unregister: unregister,

    addExpectedEvents: function(moreEvents) {
      addExpectedEvents(moreEvents);
    }
  };
};