/* Copyright IBM Corp. 2014 All Rights Reserved                      */

var cacheBustSuffix = 'v20150110-1800';

var whereApp = angular.module('whereApp', [
	'ui.bootstrap', 'ngRoute', 'leaflet-directive', 'angularSpinner', 
	'n3-line-chart', 'geolocation', 'LocalStorageModule', 'whereHttp'
]).config([
    // Make use of the where.html partial
	'$routeProvider', function($routeProvider) {
		$routeProvider.when('/where', {
			templateUrl: '/partials/where.html?cache-bust=' + cacheBustSuffix,
			controller: 'WhereController',
			activeTab: 'where'
		}).
		when('/usage', {
			templateUrl: 'partials/usage.html?cache-bust=' + cacheBustSuffix,
			controller: 'UsageController',
			activeTab: 'usage'
		}).
		otherwise({
			redirectTo: '/where'
		});
	}
]);

// Configure local storage. Our intent is to use this so
// we don't keep making a request for the same position when
// URL is reloaded in same browser tab.
whereApp.config(function(localStorageServiceProvider) {
	localStorageServiceProvider.setPrefix('whereApp');
	localStorageServiceProvider.setStorageType('sessionStorage');
});

whereApp.controller('WhereController', [
	'$scope',
	'usSpinnerService',
	'localStorageService',
	'geolocationService',
	'whereHttpService',
	function($scope, usSpinnerService, localStorageService, geolocationService, whereHttpService) {
		var DEFAULT_ZOOM_LEVEL = 12;
		var DEFAULT_SEARCH_DISTANCE = 750;
		var WHERE_HAVE_OTHERS_BEEN_LIMIT = 15;
		
		angular.extend($scope, {

			/***********************************************************
			 * Where am I?
			 **********************************************************/
			handleWhereAmI: function() {
				// If there are no coordinates then that means this is the first time
				// through. Let's prime the display with info from local storage (if
				// it exists).
				if (!$scope.currentCoordinates) {
					var lastResult = localStorageService.get('lastResult');
					if (lastResult && lastResult.currentCoordinates && lastResult.currentLocation) {
						// Put info on map
						$scope.setCenterOfMap(lastResult.currentCoordinates);
						
						// Put address and such back
						$scope.handleNewLocationPosted(lastResult.options, lastResult.currentLocation);
					}
				} else {
					// Clear our current location data
					$scope.resetLocationData();
					
					// Clear any Where Am I? alert messages
					$scope.clearWhereAmIAlert();
				}
				
				// Start a spinner over Where Am I? 
				var spinnerId = 'whereAmI-spinner';
				$scope.startSpin(spinnerId);
				
				geolocationService.getLocation().then(
					function(position) {
						var coords = $scope.currentCoordinates = position.coords;
						
						// Put info on map
						$scope.setCenterOfMap(coords);

						// We have a good geolocation, so post it to server
						$scope.postGeolocation();
					},
					function(err) {
						// Show an error and stop the spinner
						$scope.setWhereAmIAlert('danger', (err.data && err.data.message));
						$scope.stopSpin(spinnerId);
					}
				);
			},
			
			setCenterOfMap: function(coords) {
				// Put info on map
				$scope.mapCenter = {
					lat: coords.latitude,
					lng: coords.longitude,
					zoom: DEFAULT_ZOOM_LEVEL
				};
				
				// Add a marker
				$scope.markers = {
					centerMarker: {
						lat: coords.latitude,
						lng: coords.longitude,
						message: 'You are here!',
						focus: false,
						draggable: false,
						icon: {
							iconUrl: 'images/map_pin25x38.png',
							iconSize:     [25, 38], // size of the icon
							iconAnchor:   [13, 38], // point of the icon which will correspond to marker's location
							popupAnchor:  [0, -36] // point from which the popup should open relative to the iconAnchor
						}
					}
				};
			},

			postGeolocation: function() {
				// Start a spinner over Where Am I? 
				var spinnerId = 'whereAmI-spinner';
				$scope.startSpin(spinnerId);
				
				// AWE TOOO: consult local storage
				var lastResult = localStorageService.get('lastResult');
				if (lastResult && lastResult.currentCoordinates && lastResult.currentLocation) {
					var lastCurrentCoordinates = lastResult.currentCoordinates;
					if (Math.abs(lastCurrentCoordinates.latitude - $scope.currentCoordinates.latitude) < 0.00009 &&
						Math.abs(lastCurrentCoordinates.longitude - $scope.currentCoordinates.longitude) < 0.00009 ) {
					
						$scope.handleNewLocationPosted(lastResult.options, lastResult.currentLocation, spinnerId);
						return;
					}
				} else {
					localStorageService.remove('lastResult');
				}
				
				// Nothing worth reusing in local stroage, so post geolocation
				// to the server
				var options = {
					searchDistance: DEFAULT_SEARCH_DISTANCE,
					coordinates: $scope.currentCoordinates
				};
				whereHttpService.postGeolocation(options).then(
					function(data) {
						$scope.handleNewLocationPosted(options, data, spinnerId);
					},
					function(err) {
						// Show an error and stop the spinner
						var message = err.message || (err.data && err.data.message) || 'Error occurred posting geolocation to server.';
						$scope.setWhereAmIAlert('danger', message);
						$scope.stopSpin(spinnerId);
					}
				);
			},
			
			handleNewLocationPosted: function(options, data, spinnerId) {
				// Post was successful for make note of the address data
				$scope.currentLocation = data;
				$scope.addressAvailable = data.address && Object.keys(data.address).length;
				
				// If there's no near by address, so let give user a message
				// Show an error and stop the spinner
				if (!$scope.addressAvailable) {
					$scope.setWhereAmIAlert('info', 'No address within ' + options.searchDistance + ' ft.');
				}

				// Update the popular and recent lists because
				// data just changed
				$scope.updateWhereIsMostPopular();
				$scope.updateWhereHaveOthersBeen();
				
				// Let's put the information in local storage.
				if ($scope.currentCoordinates) {
					localStorageService.set('lastResult', {
						options: options,
						currentCoordinates: $scope.currentCoordinates,
						currentLocation: $scope.currentLocation,
						addressAvailable: $scope.addressAvailable
					});
				}
				
				// Stop the spinner
				if (spinnerId) {
					$scope.stopSpin(spinnerId);
				}
			},

			/***********************************************************
			 * Where Can I Go? -- aka Travel Doundary
			 **********************************************************/
			boundaryCost: 5,
			boundaryUnits: 'Minutes',
			
			handleWhereCanIGo: function() {
				// Start up a spinner
				var spinnerId = 'whereCanIGo-spinner';
				$scope.startSpin(spinnerId);
				
				// Clear out current boundary data
				$scope.resetBoundaryData();
				$scope.clearWhereCanIGoAlert();

				// Prepare params and use whereHttpService to make
				// the server call
				var currentLocationId = $scope.currentLocation.id;
				var queryParams = {
					cost: $scope.boundaryCost,
					units: $scope.boundaryUnits
				};
				whereHttpService.getTravelBoundary(currentLocationId, queryParams).then(
					function(data) {
						// Successfully got boundary so stop spinner
						$scope.stopSpin(spinnerId);

						// Set the geojson properties for Leaflet
						$scope.geojson = {
							data: data,
							style: {
								fillColor: '#0970CA',
								weight: 2,
								opacity: 0.9,
								color: '#0F2E4A',
								dashArray: '3',
								fillOpacity: 0.7
							}
						};
					},
					function(err) {
						// Show an error and stop the spinner
						var message = (err.data && err.data.message) || 'Error occurred retrieving travel boundary.';
						$scope.setWhereCanIGoAlert('danger', message);
						$scope.stopSpin(spinnerId);
					}
				);
			},
			
			/***********************************************************
			 * Where is most popular? -- location summary
			 **********************************************************/
			locationSummary: [],
			groupLevel: 1,
			updateWhereIsMostPopular: function() {
				// Start up a spinner
				var spinnerId = 'whereIsMostPopular-spinner';
				$scope.startSpin(spinnerId);
				
				whereHttpService.getLocationSummary($scope.groupLevel).then(
					function(data) {
						// Success, so stop spinner store the summary
						$scope.stopSpin(spinnerId);
						$scope.locationSummary = data;
					},
					function(err) {
						$scope.stopSpin(spinnerId);
					}
				);
			},
			
			/***********************************************************
			 * Where have others been? -- location summary
			 **********************************************************/
			recentLocations: [],
			updateWhereHaveOthersBeen: function(groupLevel) {
				// Start up a spinner
				var spinnerId = 'whereHaveOthersBeen-spinner';
				$scope.startSpin(spinnerId);
				
				whereHttpService.getRecentLocations(WHERE_HAVE_OTHERS_BEEN_LIMIT).then(
					function(data) {
						// Success, so stop spinner store the summary
						$scope.stopSpin(spinnerId);
						$scope.recentLocations = data;
					},
					function(err) {
						$scope.stopSpin(spinnerId);
					}
				);
			},
			
			/***********************************************************
			 * Utils for resetting data
			 **********************************************************/
			resetLocationData: function() {
				// Address data
				$scope.currentCoordinates = null;
				$scope.currentLocation = null;
				$scope.addressAvailable = false;
				
				// Leaflet data
				$scope.resetBoundaryData();
			},
			
			resetBoundaryData: function() {
				// Leaflet data
				$scope.geojson = null;
			},
			
			/***********************************************************
			 * Leaflet data structures
			 **********************************************************/
			mapCenter: {
				// Nothing
			},
			
			markers: {
				// Nothing
			},
			
			defaults: {
				scrollWheelZoom: false
			},
			
			// Set this because we want to use https
			tiles: {
				url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
			},

			/************************************************
			 * Where Am I? --  Alerts
			 ************************************************/
			whereAmIAlerts: [],
			setWhereAmIAlert: function(type, msg) {
				var newAlert = {type: type, msg: msg};
				if ($scope.whereAmIAlerts.length) {
					$scope.whereAmIAlerts[0] = newAlert;
				} else {
					$scope.whereAmIAlerts.push(newAlert);
				}
			},
			clearWhereAmIAlert: function() {
				if ($scope.whereAmIAlerts.length) {
					$scope.whereAmIAlerts.splice(0, 1);
				}
			},
			
			/************************************************
			 * Where Can I Go? --  Alerts
			 ************************************************/
			whereCanIGoAlerts: [],
			setWhereCanIGoAlert: function(type, msg) {
				var newAlert = {type: type, msg: msg};
				if ($scope.whereCanIGoAlerts.length) {
					$scope.whereCanIGoAlerts[0] = newAlert;
				} else {
					$scope.whereCanIGoAlerts.push(newAlert);
				}
			},
			clearWhereCanIGoAlert: function() {
				if ($scope.whereCanIGoAlerts.length) {
					$scope.whereCanIGoAlerts.splice(0, 1);
				}
			},

			/**************************************
			 * Spinners
			 **************************************/
			spinningSpinners: {},
			startSpin: function(spinnerId) {
				$scope.spinningSpinners[spinnerId] = true;
				usSpinnerService.spin(spinnerId);
			},

			stopSpin: function(spinnerId) {
				$scope.spinningSpinners[spinnerId] = false;
				usSpinnerService.stop(spinnerId);
			}
		});
		
		// Kick off getting the user's location and
		// updating the display
		$scope.handleWhereAmI();
		$scope.updateWhereIsMostPopular();
		$scope.updateWhereHaveOthersBeen();
	}
]);

//Add a custom filter to convert a date/time to 
// # of secs, minutes, hours, or days from current time
whereApp.filter('getTimeDifference', function () {
	function getTimeDifference(startDate, endDate) {
		var retVal;
			
		var diff = endDate.getTime() - startDate.getTime();
		var secs = diff / 1000;
		if (secs < 60) {
			retVal = Math.round(secs) + ' s';
		} else {
			var mins = secs / 60;
			if (mins < 60) {
				retVal = Math.round(mins) + ' m';
			} else {
				var hours = mins / 60;
				if (hours < 24) {
					retVal = Math.round(hours) + ' h';
				} else {
					var days = hours / 24;
					if (days < 365) {
						retVal = Math.round(days) + ' d';
					}
				}
			}
		}
		
		return retVal;
	}
	
	return function (isoDateString) {
		var startDate = new Date(isoDateString);
		var endDate = new Date();
		return getTimeDifference(startDate, endDate);
	};
});

/***************************************************
 * Controller for Usage View
 ***************************************************/
whereApp.controller('UsageController', [
	'$scope',
	'usSpinnerService',
	'whereHttpService',
	function($scope, usSpinnerService, whereHttpService) {
		var CHART_COLOR_SERIES_1 = '#7D110C';
		
		// Utility for building time chart options
		function getTimeChartOptions(yKey, yLabel) {
			var options = {
				axes: {
					x: {
						type: 'date',
						key: 'date'
					},
					y: {
						type: 'linear'
					}
				},
				series: [{
					y: yKey,
					label: yLabel,
					color: CHART_COLOR_SERIES_1,
					axis: 'y',
					type: 'line',
					thickness: '1px',
					dotSize: '1px',
					id: 'series_0'
				}],
				tooltip: {
					mode: 'scrubber',
					formatter: function (x, y, series) {
						return x.toLocaleDateString() + ' : ' + y;
					}
				},
				stacks: [],
				lineMode: 'linear',
				tension: 0.7,
				drawLegend: false,
				drawDots: true,
				columnsHGap: 5
			};
			return options;
		}
		
		// Utility for building bar chart options
		function getBarChartOptions(yKey, yLabel, xLabelFunction) {
			var options = {
				axes: {
					x: {
						type: 'linear',
						key: 'x',
						labelFunction: function(x) {
							return xLabelFunction(x);
						}
					},
					y: {
						type: 'linear'
					}
				},
				series: [{
					id: 'id_0',
					y: yKey,
					label: yLabel,
					type: 'column',
					color: CHART_COLOR_SERIES_1,
					axis: 'y'
				}],
				tooltip: {
					mode: 'scrubber',
					formatter: function (x, y, series) {
						return xLabelFunction(x) + ' : ' + y;
					}
				},
				stacks: [],
				lineMode: 'cardinal',
				tension: 0.7,
				drawLegend: false,
				drawDots: true,
				columnsHGap: 5
			};
			return options;
		}
		
		angular.extend($scope, {
			// Construct options for the various charts
			usageChartOptions: getTimeChartOptions('total', 'Total Locations'),
			usagePerDayChartOptions: getTimeChartOptions('value', 'Locations Per Day'),
			usageByDeviceChartOptions: getBarChartOptions('value', 'Locations by Device',
				// Custom function to map x-axis value to label
				function(x) {
					var usageByDevice = $scope.usageByDevice;
					if (x % 1 === 0 && x >= 0 && x < usageByDevice.length) {
						// We have an integer
						var usageItem = usageByDevice[x];
						return usageItem.key[0];
					}
				}
			),
			
			/***********************************************************
			 * Usage Data by Time
			 **********************************************************/
			usageByTime: [],
			usageyByTimeTotal: 0,
			usageyByTimeAverage: 0,
			usageGroupLevel: 3,
			updateUsageByTime: function() {
				whereHttpService.getLocationSummaryByTime($scope.usageGroupLevel).then(
					function(usageData) {
						// Need to massage the data for use by chart
						var usageDataTotal = 0;
						usageData.forEach(function(item) {
							var year = item.key[0];
							var month = item.key[1];
							var day = item.key[2];
							usageDataTotal += item.value;
							
							item.date = new Date(year, month, day);
							item.total = usageDataTotal;
							
						});

						$scope.usageByTime = usageData;
						$scope.usageyByTimeTotal = usageDataTotal;
						$scope.usageyByTimeAverage = usageDataTotal / (usageData.length || 1);
					}
				);
			},
			
			/***********************************************************
			 * Usage Data by Device
			 **********************************************************/
			usageByDevice: [],
			usageByDeviceGroupLevel: 1,
			updateUsageByDevice: function() {
				whereHttpService.getLocationSummaryByDevice($scope.usageByDeviceGroupLevel).then(
					function(usageData) {
						// Need to massage the data for use by chart
						usageData.forEach(function(item, index) {
							item.x = index;
						});

						$scope.usageByDevice = usageData;
					}
				);
			}
		});
		
		// Kick off getting (and displaying) some usage info
		$scope.updateUsageByTime();
		$scope.updateUsageByDevice();
	}
]);


/***************************************************
 * Controller for Header
 ***************************************************/
whereApp.controller('HeaderController', [
	'$scope',
	'$route',
	function($scope, $route) {
		$scope.$route = $route;
		
		$scope.navCollapsed = true;
	}
]);
