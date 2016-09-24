$(function(){

	var FS     = require('fs');
	var Crypto = require('crypto');
	var Loki   = require('lokijs');
	var FilesDB = {
		init: function(){
			var self = this;
			var db_loader = function(){
				self.files = self.db.getCollection('files') || self.db.addCollection('files', {unique: 'hash'});
			};
			self.db = new Loki('files.json', {
				autoload: true, autoloadCallback: db_loader,
				autosave: true, autosaveInterval: 5000
			});
		}
		,
		hash_file: function(data){
			return Crypto.createHash('sha1').update(data).digest('hex');
		}
		,
		add_file: function(filepath){
			var self = this;
			FS.readFile(filepath, function(err, data){
				var hash = self.hash_file(data);
				self.files.insert({
					path: filepath,
					hash: hash
				});
			});
		}
	}

	// Display some statistic about this computer, using node's os module.
	var os = require('os');
	var prettyBytes = require('pretty-bytes');

	$('.stats').append('Number of cpu cores: <span>' + os.cpus().length + '</span>');
	$('.stats').append('Free memory: <span>' + prettyBytes(os.freemem())+ '</span>');


	FilesDB.init();
	
	// read file from dropzone
	$(window).on('dragover drop', function(e){ e.preventDefault(); return false; });
	$('.dropzone')
	.on('dragover', function(e){
		$(this).addClass('hover');
		return false;
	}).on('dragleave', function(e){
		$(this).removeClass('hover');
		return false;
	}).on('drop', function(e){
		e.preventDefault();
		var files = e.originalEvent.dataTransfer.files;
		for (var i = 0; i < files.length; ++i){
			var filepath = files[i].path;
			FilesDB.add_file(filepath);
		}
		$(this).removeClass('hover');
		return false;
	});
	
	$('#save_db').on('click', function(){ FilesDB.db.saveDatabase(); });
});

