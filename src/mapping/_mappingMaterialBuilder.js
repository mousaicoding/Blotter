(function(Blotter, _, THREE, Detector, requestAnimationFrame, EventEmitter, GrowingPacker, setImmediate) {

  Blotter._MappingMaterialBuilder = (function() {

    function _vertexSrc () {
      var vertexSrc = [

        "varying vec2 _vTexCoord;",

        "void main() {",

        "  _vTexCoord = uv;",
        "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",

        "}"

      ];

      return vertexSrc.join("\n");
    }

    function _fragmentSrc (uniforms, mainImageSrc) {
      var fragmentSrc,
          userDefinedUniforms = {
            // Strings of sampler2D declarations for each user defined uniform texture.
            privateUniformTextureDeclarations : "",
            // Strings of uniform declarations for each publicly facing version of each user defined uniform.
            publicUniformDeclarations         : "",
            // Strings of uniform definitions for each publicly facing version of each user defined uniform.
            uniformDefinitions                : ""
          };

      _.reduce(uniforms, function (userDefinedUniforms, uniformObject, uniformName) {
        var uniformTextureName = _dataTextureNameForUniformName(uniformName),
            glslSwizzle = Blotter._UniformUtils.fullSwizzleStringForUniformType(uniformObject.type),
            glslDataType = Blotter._UniformUtils.glslDataTypeForUniformType(uniformObject.type);

        userDefinedUniforms.privateUniformTextureDeclarations += "uniform sampler2D " + uniformTextureName + ";\n";
        userDefinedUniforms.publicUniformDeclarations += glslDataType + " " + uniformName + ";\n";
        userDefinedUniforms.uniformDefinitions += uniformName + " = " + "texture2D(" + uniformTextureName + " , vec2(textIndex, 0.5))." + glslSwizzle + ";\n";

        return userDefinedUniforms;
      }, userDefinedUniforms);


      // ### - inspect this in chrome to see how the formatting is output.
      fragmentSrc = [

        "precision highp float;",

        // Private blotter defined uniforms.
        "uniform sampler2D _uSampler;",
        "uniform vec2 _uCanvasResolution;",

        "uniform sampler2D _uTextIndicesTexture;",
        "uniform sampler2D _uTextBoundsTexture;",

        // Private texCoord and bounds information.
        "varying vec2 _vTexCoord;",
        "vec4 _textBounds;",

        // Public blotter defined uniforms.
        "vec2 uResolution;",

        // Private versions of use user defined uniforms
        userDefinedUniforms.privateUniformTextureDeclarations,

        // Public versions of user defined uniforms.
        userDefinedUniforms.publicUniformDeclarations,

        // Public helper function used by user programs to retrieve texel color information within the bounds of
        // any given text text. This is to be used instead of `texture2D`.
        "vec4 textTexture( vec2 coord ) {",
        "   vec2 adjustedFragCoord = _textBounds.xy + vec2((_textBounds.z * coord.x), (_textBounds.w * coord.y));",
        "   vec2 uv = adjustedFragCoord.xy / _uCanvasResolution;",
        //  If adjustedFragCoord falls outside the bounds of the current texel's text, return `vec4(0.0)`.
        "   if (adjustedFragCoord.x < _textBounds.x ||",
        "       adjustedFragCoord.x > _textBounds.x + _textBounds.z ||",
        "       adjustedFragCoord.y < _textBounds.y ||",
        "       adjustedFragCoord.y > _textBounds.y + _textBounds.w) {",
        "     return vec4(0.0);",
        "   }",
        "   return texture2D(_uSampler, uv);",
        "}",

      // ### - what other methods ought we expose?

        "void mainImage( out vec4 mainImage, in vec2 fragCoord );",

        mainImageSrc,

        "void main( void ) {",

        //  Retrieve text index and text alpha for text bounds in which texel is contained.
        "   vec4 textIndexData = texture2D(_uTextIndicesTexture, _vTexCoord);",
        "   float textIndex = textIndexData.r;",
        "   float textAlpha = textIndexData.a;",

        //  Make bounds for the current text globally visible.
        "   _textBounds = texture2D(_uTextBoundsTexture, vec2(textIndex, 0.5));",

        //  Set "uniform" values visible to user.
        "   uResolution = _textBounds.zw;",
            userDefinedUniforms.uniformDefinitions,

        //  Set fragment coordinate in respect to position within text bounds.
        "   vec2 fragCoord = gl_FragCoord.xy - _textBounds.xy;",
        //  Call user defined fragment function, setting outColor on return.
        "   vec4 outColor;",
        "   mainImage(outColor, fragCoord);",

        //  Multiply alpha by original textIndexData's fourth value."
        //  this will be 0 for texels not within any 'text' area."
        "   outColor.a = outColor.a * textAlpha;",
        "   gl_FragColor = outColor;",
        "}"

      ];

      return fragmentSrc.join("\n");
    }

    function _userUniformDataTextureNameForUniformName (uniformName) {
      return "_" + uniformName + "Texture";
    }

    function _buildMappedTextsTexture (mapping, completion) {
      Blotter._TextTextureBuilder.build(mapping, function (texture) {
        completion(texture);
      }));
    }

    function _buildMappingDataTextureObjects (mapping, completion) {
      var buildIndicesTexture,
          buildBoundsTexture,
          mappingDataTextureObjects = [],
          buildStages;

      buildIndicesTexture = function () {
        return function (next) {
          Blotter._IndicesDataTextureBuilder.build(mapping, function (texture) {
            mappingDataTextureObjects.push({
              uniformName : "_uTextIndicesTexture",
              texture : texture
            });
            next();
          });
        };
      };

      buildBoundsTexture = function () {
        return function (next) {
          Blotter._BoundsDataTextureBuilder.build(mapping, function (texture) {
            mappingDataTextureObjects.push({
              uniformName : "_uTextBoundsTexture",
              texture : texture
            });
            next();
          });
        };
      };

      buildStages = [
        buildIndicesTexture(),
        buildBoundsTexture()
      ];

      _(buildStages).reduceRight(_.wrap, function () {
        completion(mappingDataTextureObjects);
      })();
    }

    function _buildUserUniformDataTextureObjects (userUniforms, dataLength, completion) {
      userUniforms = Blotter._UniformUtils.extractValidUniforms(userUniforms);

      return _.reduce(userUniforms, function (memo, userUniform, uniformName) {
        var data = new Float32Array(dataLength * 4);
        memo[uniformName] = {
          userUniform : userUniform,
          data : data,
          texture : new THREE.DataTexture(data, dataLength, 1, THREE.RGBAFormat, THREE.FloatType)
        };
        return memo;
      }, {});
    }

    function _getUniformsForMappingDataTextureObjects (mappingDataTextureObjects) {
      return _.reduce(mappingDataTextureObjects, function (memo, mappingDataTextureObject) {
        memo[mappingDataTextureObject.uniformName] = {
          type : "t",
          value : mappingDataTextureObject.texture
        };
        return memo;
      }, {});
    }

    function _getUniformsForUserUniformDataObjects (userUniformDataObjects) {
      return _.reduce(userUniformDataObjects, function (memo, uniformDataObject, uniformName) {
        memo[_userUniformDataTextureNameForUniformName(uniformName)] = {
          type : "t",
          value : uniformDataObject.texture
        };
        return memo;
      }, {});
    }

    function _getUniforms (width, height, mappedTextsTexture, mappingDataTextureObjects, userUniformDataTextureObjects) {
      var uniforms = {
        _uSampler : { type : "t", value : mappedTextsTexture },
        _uCanvasResolution : { type : "2f", value : [width, height] }
      };

      _.extend(uniforms, _getUniformsForMappingDataTextureObjects(mappingDataTextureObjects));
      _.extend(uniforms, _getUniformsForUserUniformDataObjects(userUniformDataTextureObjects));

      return uniforms;
    }

    function _getThreeMaterial (vertexSrc, fragmentSrc, uniforms) {
      var threeMaterial = new THREE.ShaderMaterial({
        vertexShader : vertexSrc,
        fragmentShader : fragmentSrc,
        uniforms : uniforms
      });

      threeMaterial.depthTest = false;
      threeMaterial.depthWrite = false;
      threeMaterial.premultipliedAlpha = false;

      return threeMaterial;
    }

    return {

      build : function (mapping, material, completion) {
        var buildMappedTextsTexture,
            buildMappingDataTextureObjects,
            buildUserUniformDataAndDataTextureObjects,
            mappedTextsTexture,
            mappingDataTextureObjects,
            userUniformDataAndDataTextureObjects,
            buildStages;

        buildMappedTextsTexture = function () {
          return function (next) {
            _buildMappedTextsTexture(mapping, function (texture) {
              mappedTextsTexture = texture;
              next();
            });
          };
        };

        buildMappingDataTextureObjects = function () {
          return function (next) {
            _buildMappingDataTextureObjects(mapping, function (objects) {
              mappingDataTextureObjects = objects;
              next();
            });
          };
        };

        buildUserUniformDataTextureObjects = function () {
          return function (next) {
            _buildUserUniformDataTextureObjects(material.uniforms, mapping.texts.length, function (objects) {
              userUniformDataTextureObjects = objects;
              next();
            });
          }
        };

        buildStages = [
          buildMappedTextsTexture(),
          buildMappingDataTextureObjects(),
          buildUserUniformDataTextureObjects()
        ];

        _(buildStages).reduceRight(_.wrap, function () {
          var uniforms = _getUniforms(
                mapping.width,
                mapping.height,
                mappedTextsTexture,
                mappingDataTextureObjects,
                userUniformDataTextureObjects
              ),
              threeMaterial = _getThreeMaterial(_vertexSrc(), _fragmentSrc(), uniforms);

          completion(new Blotter._MappingMaterial(mapping, material, threeMaterial, userUniformDataTextureObjects);
        })();
      }
    };
  })();

})(
  this.Blotter, this._, this.THREE, this.Detector, this.requestAnimationFrame, this.EventEmitter, this.GrowingPacker, this.setImmediate
);
