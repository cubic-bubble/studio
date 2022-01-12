
/* eslint no-bitwise: 0, jsx-no-bind: 0 */
import React, { Component } from 'react';
import PropTypes from 'prop-types';
import _ from 'lodash';
import { bindActionCreators } from 'redux';
import { connect } from 'react-redux';
import axios from 'axios';
import { Button, Icon, message, Modal, Spin, Tooltip } from 'antd';
import SplitPane from 'rspv2/lib/SplitPane';
import Pane from 'rspv2/lib/Pane';
import qs from 'qs';
import {
  fetchFileContent,
  fetchFiles,
  saveFile,
  showDemoAlert,
  stickTab,
  setViewChanged,
} from '../home/redux/actions';
import editorStateMap from './editorStateMap';
import modelManager from './modelManager';
import { storage } from '../common/utils';
import { MonacoEditor, EditorSider } from './';
import plugin from '../../common/plugin';

export class CodeEditor extends Component {
  static propTypes = {
    elementById: PropTypes.object.isRequired,
    fileContentById: PropTypes.object.isRequired,
    fileContentNeedReload: PropTypes.object.isRequired,
    fetchFileContentPending: PropTypes.bool.isRequired, // eslint-disable-line
    saveFilePending: PropTypes.bool.isRequired,
    actions: PropTypes.object.isRequired,
    file: PropTypes.string.isRequired,
    onError: PropTypes.func,
    onStateChange: PropTypes.func,
    onRunTest: PropTypes.func,
    match: PropTypes.object.isRequired,
    router: PropTypes.object.isRequired,
  };

  static defaultProps = {
    onError() {},
    onStateChange() {},
    onRunTest: null,
  };

  constructor(props) {
    super(props);
    // BIG magic here! When open/switch a new file, it will trigger cursor change first
    // which causes to save status. So if the file is new open, should not save its state
    // before recover the state. So when file is changed set this flag to true. After recover
    // the status, set it to false so that state could be saved.
    this.preventSaveEditorState = true;

    this.monacoListeners = [];
  }

  state = {
    notFound: false,
    loadingFile: false,
    loadingFiles: {},
    loadingEditor: true,
    cursorPos: {
      lineNumber: 1,
      column: 1,
    },
    showOutline: !storage.local.getItem('noOutline'),
  };

  setLoading(file, loading) {
    this.setState({
      loadingFiles: {
        ...this.state.loadingFiles,
        [file]: loading,
      },
    });
  }

  async componentDidMount() {
    this.setState({
      loadingFile: true,
    });
    this.setLoading(this.props.file, true);
    await this.checkAndFetchFileContent(this.props);
    modelManager.setValue(this.props.file, this.getFileContent());
    this.setState({
      loadingFile: false,
    });
    this.props.onStateChange({ hasChange: false });
    this.setEditorStateFromSearch();
  }

  async componentDidUpdate(prevProps) {
    const { props } = this;
    if (props.router.location.search !== prevProps.router.location.search) {
      setTimeout(() => {
        this.setEditorStateFromSearch();
        this.recoverEditorState();
      }, 200);
    }

    const hasChange = this.hasChange(); // has changed
    const oldContent = this.getFileContent();

    if (props.file !== prevProps.file) {
      this.preventSaveEditorState = true;
      this.setState({ loadingFile: true }, () => this.editor.layout());
      await this.checkAndFetchFileContent(props);
      this.preventSaveEditorState = false;
      this.recoverEditorState();
      this.setState({ loadingFile: false });
    } else if (props.fileContentNeedReload[props.file] && !props.fetchFileContentPending) {
      await this.checkAndFetchFileContent(props);
      this.setState({
        loadingFile: false,
      });
    }
    const newContent = this.getFileContent();
    if (
      hasChange &&
      oldContent !== newContent &&
      newContent !== modelManager.getValue(props.file)
    ) {
      Modal.confirm({
        title: 'The file has changed on disk.',
        content: 'Do you want to reload it?',
        okText: 'Yes',
        cancelText: 'No',
        onOk: () => {
          modelManager.setValue(props.file, newContent);
        },
      });
    } else if (!hasChange) {
      modelManager.setValue(props.file, newContent);
    }
  }

  componentWillUnmount() {
    this.monacoListeners.forEach(lis => lis.dispose());
  }

  setEditorStateFromSearch() {
    const { file, router } = this.props;
    const selection = _.mapValues(qs.parse(router.location.search.replace(/^\?*/, '')), v =>
      parseInt(v, 10),
    );
    if (
      ['startColumn', 'endColumn', 'startLineNumber', 'endLineNumber'].some(
        k => !_.has(selection, k),
      )
    ) {
      return;
    }
    _.merge(editorStateMap, {
      [file]: {
        viewState: {
          firstPosition: {
            column: selection.startColumn,
            lineNumber: Math.max(selection.startLineNumber - 5, 0),
          },
        },
        cursorState: [
          {
            inSelectionMode: true,
            position: {
              column: selection.startColumn,
              lineNumber: selection.startLineNumber,
            },
            selectionStart: {
              column: selection.startColumn,
              lineNumber: selection.startLineNumber,
            },
          },
        ],
      },
    });
  }

  getFileContent(filePath) {
    return this.props.fileContentById[filePath || this.props.file];
  }

  getOutlineWidth() {
    return this.hasOutline() && this.state.showOutline ? this.props.outlineWidth : 0;
  }

  hasOutline() {
    return this.props.file.split('.').pop() === 'js';
  }

  formatCode = () => {
    this.setState({ loadingFile: true });
    const lines = this.editor.getValue().split('\n');
    const { lineNumber, column } = this.editor.getPosition();
    const cursorOffset =
      lines.slice(0, lineNumber - 1).reduce((c, line) => c + line.length + 1, 0) + column - 1;

    axios
      .post('/api/format-code', {
        content: modelManager.getValue(this.props.file),
        file: this.props.file,
        cursorOffset,
      })
      .then(res => {
        if (res.data.error || !res.data.content.formatted) {
          this.setState({ loadingFile: false });
          return;
        }
        this.editor.executeEdits('format', [
          {
            range: new monaco.Range(1, 1, 1000000, 1),
            text: res.data.content.formatted,
            forceMoveMarkers: true,
          },
        ]);
        const newCursorOffset = res.data.content.cursorOffset;
        const newLines = res.data.content.formatted.split('\n');
        let c = 0;
        let newLineNumber = 0;
        while (
          c + newLines[newLineNumber].length + 1 < newCursorOffset &&
          newLineNumber < newLines.length
        ) {
          c += newLines[newLineNumber].length + 1;
          newLineNumber += 1;
        }
        const col = newCursorOffset - c;
        this.editor.setPosition({ lineNumber: newLineNumber + 1, column: col + 1 });
        this.setState({
          loadingFile: false,
        });
      })
      .catch(() => {
        this.setState({
          loadingFile: false,
        });
      });
  };

  recoverEditorState = () => {
    if (!this.editor) return;
    const { file } = this.props;
    this.preventSaveEditorState = false;
    const editorState = editorStateMap[file] || null;
    this.editor.restoreViewState(editorState);
    this.editor.focus();
  };

  hasChange() {
    // Whether the editor content is different from which in store.
    return modelManager.isChanged(this.props.file);
    // return this.state.currentContent !== this.getFileContent();
  }

  checkAndFetchFileContent() {
    // Check if content exists or need reload, if yes then fetch it.
    const {
      fileContentById,
      fileContentNeedReload,
      fetchFileContentPending,
      file,
      actions,
    } = this.props;
    if (
      (!_.has(fileContentById, file) || fileContentNeedReload[file]) &&
      !fetchFileContentPending
    ) {
      return actions
        .fetchFileContent(file)
        .then(() => {
          this.setState({ notFound: false });
        })
        .catch(e => {
          message.error(`Failed to load file: ${e.toString()}`);
          if (_.get(e, 'response.status') === 404) {
            this.setState({ notFound: true, loadingFile: false });
            this.props.onError(404);
          }
        });
    } else {
      this.setState({ notFound: false });
      return Promise.resolve();
    }
  }

  handleEditorChange = () => {
    const pathname = document.location.pathname;
    this.props.actions.setViewChanged(pathname, this.hasChange());
    if (this.hasChange()) {
      this.props.actions.stickTab();
    }
  };

  handleOutlineSelect = nodeData => {
    if (nodeData.startLine && this.editor) {
      this.editor.setScrollTop(this.editor.getTopForLineNumber(nodeData.startLine));
    }
  };

  handleEditorDidMount = editor => {
    this.editor = editor;
    window.GLOBAL_EDITOR = editor;
    editor.focus();
    // This seems to be able to add multiple times.
    editor.addCommand([monaco.KeyMod.CtrlCmd | monaco.KeyCode.KEY_S], () => {
      this.handleSave();
    });
    editor.addCommand([monaco.KeyMod.CtrlCmd | monaco.KeyCode.KEY_O], () => {
      this.handleToggleOutline();
    });
    editor.addCommand([monaco.KeyMod.CtrlCmd | monaco.KeyCode.KEY_B], () => {
      this.formatCode();
    });
    this.monacoListeners.push(
      editor.onDidChangeCursorPosition(() => this.setState({ cursorPos: editor.getPosition() })),
      editor.onDidChangeCursorPosition(this.handleEditorCursorScrollerChange),
      editor.onDidScrollChange(this.handleEditorCursorScrollerChange),
    );
    this.setState({
      loadingEditor: false,
    });
    // // It needs some time for editor to load its content
    setTimeout(this.recoverEditorState, 30);
  };

  handleEditorCursorScrollerChange = () => {
    if (this.preventSaveEditorState) return;
    const { file } = this.props;

    editorStateMap[file] = this.editor.saveViewState();
  };

  handleRunTest = () => {
    this.props.onRunTest();
  };

  handleSave = () => {
    this.props.actions.stickTab();
    if (!this.hasChange()) return;
    this.props.actions
      .saveFile(this.props.file, this.editor.getValue())
      .then(() => {
        this.props.actions.setViewChanged(document.location.pathname, false);
      })
      .catch(() => {
        if (process.env.REKIT_ENV === 'demo') {
          this.props.actions.showDemoAlert();
          return;
        }
        Modal.error({
          title: 'Failed to save.',
          content: 'Please retry or use other text editor.',
        });
      });
  };

  handleCancel = () => {
    Modal.confirm({
      content: 'Are you sure to discard your changes?',
      okText: 'Discard',
      cancelText: 'No',
      onOk: () => {
        modelManager.setValue(this.props.file, modelManager.getInitialValue(this.props.file));
      },
    });
  };

  handleToggleOutline = () => {
    this.setState(
      {
        showOutline: !this.state.showOutline,
      },
      () => {
        this.editor.layout();
        storage.local.setItem('noOutline', !this.state.showOutline);
      },
    );
  };

  handleResize = () => {
    window.dispatchEvent(new window.Event('resize'));
  };
  handleResizeEnd = sizes => {
    storage.local.setItem('editorPaneSizes', sizes);
  };

  renderToolbar() {
    const hasChange = this.hasChange();
    const { saveFilePending } = this.props;

    return (
      <div className="code-editor-toolbar">
        <div className="file-path">{this.props.file}</div>
        <div>
          {this.state.cursorPos.column && (
            <span className="cursor-pos">
              Ln {this.state.cursorPos.lineNumber}, Col {this.state.cursorPos.column}
            </span>
          )}
          <Tooltip
            overlayClassName="tooltip-no-arrow"
            title={
              <label>
                Beautify your code using prettier{' '}
                <span style={{ color: '#888', fontSize: '12px' }}>
                  ({/^Mac/.test(window.navigator.platform) ? 'Cmd' : 'Ctrl'}
                  +B)
                </span>
              </label>
            }
          >
            <Button onClick={this.formatCode} size="small">
              <Icon type="menu-fold" />
            </Button>
          </Tooltip>
          {this.props.onRunTest && (
            <Button type="primary" onClick={this.handleRunTest} size="small">
              <Icon type="play-circle-o" /> Run test
            </Button>
          )}
          {hasChange && !this.state.loadingFile && (
            <Tooltip
              title={
                <label>
                  Save{' '}
                  <span style={{ color: '#888', fontSize: '12px' }}>
                    ({/^Mac/.test(window.navigator.platform) ? 'Cmd' : 'Ctrl'}
                    +S)
                  </span>
                </label>
              }
            >
              <Button
                type="primary"
                size="small"
                loading={saveFilePending}
                disabled={saveFilePending}
                onClick={this.handleSave}
              >
                <Icon type="save" />
              </Button>
            </Tooltip>
          )}
          {hasChange && !this.state.loadingFile && (
            <Tooltip title="Discard changes">
              <Button size="small" onClick={this.handleCancel} disabled={saveFilePending}>
                <Icon type="close-circle" />
              </Button>
            </Tooltip>
          )}
          {this.hasOutline() && (
            <Tooltip
              title={
                <label>
                  Toggle Sider{' '}
                  <span style={{ color: '#888', fontSize: '12px' }}>
                    ({/^Mac/.test(window.navigator.platform) ? 'Cmd' : 'Ctrl'}
                    +O)
                  </span>
                </label>
              }
            >
              <Button size="small" onClick={this.handleToggleOutline}>
                <Icon type="bars" />
              </Button>
            </Tooltip>
          )}
          {plugin.getPlugins('editor.toolbar.getButtons').reduce((p, c) => {
            p.push.apply(p, c.editor.toolbar.getButtons(this.props.file) || []);
            return p;
          }, [])}
        </div>
      </div>
    );
  }

  render() {
    if (this.state.notFound) {
      return (
        <div className="editor-code-editor">
          <div className="code-editor-toolbar">
            <div className="file-path" title={this.props.file}>
              {this.props.file}
            </div>
          </div>
          <div style={{ color: 'red', marginTop: '10px', marginLeft: '15px' }}>File not found.</div>
        </div>
      );
    }
    const options = {
      selectOnLineNumbers: true,
      wrappingIndent: 'same',
    };
    const editorPaneSizes = storage.local.getItem('editorPaneSizes') || ['1', '200px'];
    const { file } = this.props;
    const editorFile = _.has(this.props.fileContentById, file)
      ? file
      : '_file_place_holder_for_loading';
    return (
      <div className="editor-code-editor">
        {this.renderToolbar()}
        <SplitPane
          split="vertical"
          className="editor-split-pane"
          onChange={this.handleResize}
          onResizeEnd={this.handleResizeEnd}
        >
          <Pane className="monaco-editor-container" size={editorPaneSizes[0]}>
            {(this.state.loadingFile || this.state.loadingEditor) && (
              <div className="loading-container">
                <Spin size="large" />
              </div>
            )}
            <MonacoEditor
              file={editorFile}
              options={options}
              onChange={this.handleEditorChange}
              editorDidMount={this.handleEditorDidMount}
            />
          </Pane>
          {this.editor && this.hasOutline() && this.state.showOutline && (
            <Pane minSize="50px" maxSize="80%" size={editorPaneSizes[1]}>
              <EditorSider
                file={this.props.file}
                code={this.editor.getValue()}
                width={this.getOutlineWidth()}
                onSelectNode={this.handleOutlineSelect}
                showDepsView={!!this.props.elementById[this.props.file]}
              />
            </Pane>
          )}
        </SplitPane>
      </div>
    );
  }
}

/* istanbul ignore next */
function mapStateToProps(state) {
  return {
    router: state.router,
    fileContentById: state.home.fileContentById,
    elementById: state.home.elementById,
    fileContentNeedReload: state.home.fileContentNeedReload,
    fetchFileContentPending: state.home.fetchFileContentPending,
    fetchFilesPending: state.home.fetchFilesPending,
    saveFilePending: state.home.saveFilePending,
  };
}

/* istanbul ignore next */
function mapDispatchToProps(dispatch) {
  return {
    actions: bindActionCreators(
      { fetchFileContent, fetchFiles, saveFile, showDemoAlert, stickTab, setViewChanged },
      dispatch,
    ),
  };
}

export default connect(
  mapStateToProps,
  mapDispatchToProps,
)(CodeEditor);